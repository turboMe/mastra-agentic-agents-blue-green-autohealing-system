/**
 * Producer-hunt workflow (10 stepów) — port z jarvis
 * (apps/workers/src/agents/marketing-agent: outreach.ts, enrichment.ts, drafting.ts, index.ts).
 *
 * Mapowanie steps → jarvis (per plan §8.1):
 *   01 discover-leads          ← steps/outreach.ts (Tavily/NotebookLM zastąpione marketingAgent.generate)
 *   02 create-research-leads   ← index.ts:461-478 (lead bez maila → status `research_needed`)
 *   03 enrich-leads            ← steps/enrichment.ts (deep research; tu fallback przez agent.generate)
 *   04 extract-emails          ← index.ts:499-510 (LLM email-extraction)
 *   05 draft-cold-emails       ← steps/drafting.ts
 *   06 create-gmail-drafts     ← gmail.createDraft
 *   07 save-drafts-fs          ← DraftsStore.save (lib/drafts-store.ts)
 *   08 update-crm              ← crm.upsertLead + addInteraction
 *   09 await-approval          ← workflow.suspend()
 *   10 send-on-approve         ← gmail.sendDraft per draft
 *
 * Uwaga: NotebookLM/Tavily nie są jeszcze zintegrowane w mastra (Etap 4C/4D),
 * więc enrichment używa fallbacku przez marketingAgent zamiast prawdziwego deep research.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { marketingAgent } from '../agents/marketing-agent';
import { getDb } from '../lib/mongo';
import { GmailService } from '../tools/google/gmail.js';
import { getDraftsStore } from '../lib/drafts-store.js';

// ── Schemas ─────────────────────────────────────────────────────────────────
const leadSchema = z.object({
  company: z.string(),
  email: z.string().optional(),
  website: z.string().optional(),
  reason: z.string().optional(),
});
type Lead = z.infer<typeof leadSchema>;

const enrichedLeadSchema = leadSchema.extend({
  rawAnalysis: z.string(),
  personalizationHook: z.string(),
});
type EnrichedLead = z.infer<typeof enrichedLeadSchema>;

const draftSchema = z.object({
  taskId: z.string(),
  draftId: z.string(),
  company: z.string(),
  email: z.string(),
  subject: z.string(),
  body: z.string(),
  enrichment: enrichedLeadSchema.optional(),
  gmailDraftId: z.string().optional(),
  fsPath: z.string().optional(),
});
type Draft = z.infer<typeof draftSchema>;

const isValidEmail = (e?: string): e is string =>
  !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const tryParseJson = <T = unknown>(text: string): T | null => {
  try {
    const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
    return JSON.parse(match ? match[1] : text);
  } catch {
    return null;
  }
};

// ── Step 01: discover-leads ─────────────────────────────────────────────────
const discoverLeadsStep = createStep({
  id: 'discover-leads',
  description: 'Wyszukuje lokalnych producentów w zadanym regionie (LLM-driven discovery).',
  inputSchema: z.object({
    region: z.string(),
    count: z.number().default(10),
    productType: z.string().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    leads: z.array(leadSchema),
  }),
  execute: async (context) => {
    const taskId = `producer-hunt-${randomUUID().slice(0, 8)}`;
    console.log(`[producer-hunt:${taskId}] discover-leads region=${context.inputData.region}`);
    const prompt = `Znajdź ${context.inputData.count} lokalnych producentów żywności z województwa ${context.inputData.region}.
Specjalizacja: ${context.inputData.productType ?? 'ogólna'}.
Zwróć WYŁĄCZNIE JSON: { "leads": [{ "company": "...", "email": "...", "website": "...", "reason": "..." }] }
Pole "email" zostaw puste jeśli nie znasz; "website" jeśli możliwe.`;
    const res = await marketingAgent.generate(prompt);
    const parsed = tryParseJson<{ leads?: Lead[] } | Lead[]>(res.text);
    let leads: Lead[] = [];
    if (Array.isArray(parsed)) leads = parsed;
    else if (parsed && Array.isArray(parsed.leads)) leads = parsed.leads;

    if (leads.length === 0) {
      console.warn(`[producer-hunt:${taskId}] LLM nie zwrócił leadów — fallback mock.`);
      leads = [
        { company: 'Farma Testowa', email: 'test@farma.pl', reason: 'Produkcja serów' },
      ];
    }
    return { taskId, region: context.inputData.region, leads };
  },
});

// ── Step 02: create-research-leads ──────────────────────────────────────────
const createResearchLeadsStep = createStep({
  id: 'create-research-leads',
  description:
    'Leady bez maila trafiają do CRM ze statusem research_needed (do późniejszego pogłębienia).',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    leads: z.array(leadSchema),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    validLeads: z.array(leadSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, leads } = context.inputData;
    const validLeads = leads.filter((l) => isValidEmail(l.email) || l.website);
    const researchOnly = leads.filter((l) => !isValidEmail(l.email) && l.website);
    const db = await getDb();

    for (const lead of researchOnly) {
      await db.collection('leads').updateOne(
        { companyName: lead.company, region },
        {
          $set: {
            companyName: lead.company,
            segment: 'producer',
            region,
            status: 'research_needed',
            website: lead.website,
            updatedAt: new Date(),
            metadata: {
              reason: 'missing_email',
              originalEmail: lead.email,
              discoveryReason: lead.reason,
              taskId,
            },
          },
          $setOnInsert: { createdAt: new Date(), id: `research-${randomUUID().slice(0, 8)}`, history: [] },
        },
        { upsert: true },
      );
    }
    console.log(
      `[producer-hunt:${taskId}] research-only=${researchOnly.length}, valid=${validLeads.length}`,
    );
    return { taskId, region, validLeads, researchOnlyCount: researchOnly.length };
  },
});

// ── Step 03: enrich-leads ───────────────────────────────────────────────────
const enrichLeadsStep = createStep({
  id: 'enrich-leads',
  description: 'Pogłębiony research firm (zwraca personalizationHook do drafterów).',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    validLeads: z.array(leadSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enriched: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, validLeads } = context.inputData;
    const enriched: EnrichedLead[] = [];
    for (const lead of validLeads) {
      try {
        const prompt = `Zrób krótki research firmy "${lead.company}" (region ${region}).
Strona: ${lead.website ?? 'nieznana'}. Powód kontaktu: ${lead.reason ?? 'lokalny producent'}.
Zwróć WYŁĄCZNIE JSON:
{ "personalizationHook": "1-2 zdania konkretu o firmie do użycia w mailu",
  "rawAnalysis": "5 zdań analizy (produkty, USP, ciekawostki)" }`;
        const res = await marketingAgent.generate(prompt);
        const parsed = tryParseJson<{ personalizationHook?: string; rawAnalysis?: string }>(
          res.text,
        );
        enriched.push({
          ...lead,
          personalizationHook:
            parsed?.personalizationHook ??
            `Lokalny producent z ${region}, profil: ${lead.reason ?? 'żywność lokalna'}.`,
          rawAnalysis:
            parsed?.rawAnalysis ?? `Brak głębokiego researchu (fallback). Powód: ${lead.reason ?? '-'}`,
        });
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] enrichment fail dla ${lead.company}:`,
          (err as Error).message,
        );
        enriched.push({
          ...lead,
          personalizationHook: lead.reason ?? 'Lokalny producent',
          rawAnalysis: 'Enrichment niedostępny.',
        });
      }
    }
    return {
      taskId,
      region,
      enriched,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 04: extract-emails ─────────────────────────────────────────────────
const extractEmailsStep = createStep({
  id: 'extract-emails',
  description:
    'Dla leadów bez maila ale z rawAnalysis próbuje wyciągnąć adres przez LLM (jarvis index.ts:499-510).',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enriched: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enrichedWithEmails: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, enriched } = context.inputData;
    const out: EnrichedLead[] = [];
    for (const lead of enriched) {
      if (isValidEmail(lead.email)) {
        out.push(lead);
        continue;
      }
      try {
        const prompt = `Wyciągnij adres e-mail dla firmy "${lead.company}" z poniższego kontekstu.
Zwróć WYŁĄCZNIE adres email lub słowo "null".
Kontekst: ${lead.rawAnalysis}\nStrona: ${lead.website ?? '-'}`;
        const res = await marketingAgent.generate(prompt);
        const candidate = res.text.trim().replace(/^"|"$/g, '');
        if (isValidEmail(candidate)) {
          console.log(`[producer-hunt:${taskId}] znaleziono email dla ${lead.company}: ${candidate}`);
          out.push({ ...lead, email: candidate });
        } else {
          console.warn(`[producer-hunt:${taskId}] brak emaila dla ${lead.company} — pomijam.`);
        }
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] extract-email fail ${lead.company}:`,
          (err as Error).message,
        );
      }
    }
    return {
      taskId,
      region,
      enrichedWithEmails: out,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 05: draft-cold-emails ──────────────────────────────────────────────
const draftColdEmailsStep = createStep({
  id: 'draft-cold-emails',
  description: 'Tworzy spersonalizowany cold-email dla każdego enriched lead z mailem.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enrichedWithEmails: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, enrichedWithEmails } = context.inputData;
    const drafts: Draft[] = [];
    for (const lead of enrichedWithEmails) {
      if (!isValidEmail(lead.email)) continue;
      const prompt = `Napisz krótki (max 4 zdania) spersonalizowany cold-email do "${lead.company}".
Wykorzystaj personalizationHook: ${lead.personalizationHook}.
Zaproponuj współpracę z GastroBridge (sprzedaż bezpośrednia do restauracji, RHD).
Język: polski. Zwróć WYŁĄCZNIE JSON: { "subject": "...", "body": "..." }`;
      const res = await marketingAgent.generate(prompt);
      const parsed = tryParseJson<{ subject?: string; body?: string }>(res.text);
      if (!parsed?.subject || !parsed?.body) {
        console.warn(`[producer-hunt:${taskId}] draft fail ${lead.company}`);
        continue;
      }
      drafts.push({
        taskId,
        draftId: `email-${randomUUID().slice(0, 6)}`,
        company: lead.company,
        email: lead.email,
        subject: parsed.subject,
        body: parsed.body,
        enrichment: lead,
      });
    }
    return {
      taskId,
      region,
      drafts,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 06: create-gmail-drafts ────────────────────────────────────────────
const createGmailDraftsStep = createStep({
  id: 'create-gmail-drafts',
  description: 'Zapisuje każdy draft jako Gmail draft (do późniejszej akceptacji + wysyłki).',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, drafts } = context.inputData;
    const result: Draft[] = [];
    let gmail: GmailService | null = null;
    for (const draft of drafts) {
      try {
        gmail ??= await GmailService.create();
        const gmailDraftId = await gmail.createDraft({
          to: draft.email,
          subject: draft.subject,
          body: draft.body,
        });
        console.log(`[producer-hunt:${taskId}] gmail draft saved id=${gmailDraftId}`);
        result.push({ ...draft, gmailDraftId });
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] gmail.createDraft fail ${draft.email}:`,
          (err as Error).message,
        );
        result.push(draft);
      }
    }
    return {
      taskId: context.inputData.taskId,
      region: context.inputData.region,
      drafts: result,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 07: save-drafts-fs ─────────────────────────────────────────────────
const saveDraftsFsStep = createStep({
  id: 'save-drafts-fs',
  description:
    'Zapisuje draft.md + draft.meta.json do filesystemu (zgodne z layoutem jarvis dashboardu).',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, drafts } = context.inputData;
    const store = getDraftsStore();
    await store.ensureBaseDir();
    const result: Draft[] = [];
    for (const draft of drafts) {
      const content = `**Do:** ${draft.email}\n**Firma:** ${draft.company}\n**Strona:** ${draft.enrichment?.website ?? 'nieznana'}\n**Temat:** ${draft.subject}\n\n---\n\n${draft.body}`;
      try {
        const fsPath = await store.save({
          taskId,
          draftId: draft.draftId,
          content,
          metadata: {
            draftId: draft.draftId,
            taskId,
            type: 'cold-email',
            language: 'pl',
            status: 'draft',
            company: draft.company,
            region,
            segment: 'producer',
            enrichment: draft.enrichment,
            gmailDraftId: draft.gmailDraftId,
            createdAt: new Date().toISOString(),
            agentId: 'marketing-agent',
            llm: { provider: 'mastra', model: 'gemini-2.5-pro', costUsd: 0 },
          },
        });
        result.push({ ...draft, fsPath });
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] save-fs fail ${draft.draftId}:`,
          (err as Error).message,
        );
        result.push(draft);
      }
    }
    return {
      taskId,
      region,
      drafts: result,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 08: update-crm ─────────────────────────────────────────────────────
const updateCrmStep = createStep({
  id: 'update-crm',
  description: 'Upsert leadów do CRM (status=draft_gotowy) + zapis interakcji draft_created.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, drafts } = context.inputData;
    const db = await getDb();
    const now = new Date();
    for (const draft of drafts) {
      const interaction = {
        action: 'draft_created',
        description: `Wygenerowano draft (id=${draft.draftId}) po enrichment.`,
        agentId: 'marketing-agent',
        ts: now,
      };
      await db.collection('leads').updateOne(
        { email: draft.email },
        {
          $set: {
            email: draft.email,
            companyName: draft.company,
            segment: 'producer',
            region,
            status: 'draft_gotowy',
            website: draft.enrichment?.website,
            updatedAt: now,
            metadata: {
              enrichment: draft.enrichment,
              draft: {
                subject: draft.subject,
                body: draft.body,
                draftId: draft.draftId,
                gmailDraftId: draft.gmailDraftId,
                fsPath: draft.fsPath,
              },
              taskId,
            },
          },
          $setOnInsert: {
            createdAt: now,
            id: draft.email,
            history: [],
          },
          $push: { history: interaction } as never,
        },
        { upsert: true },
      );
    }
    return {
      taskId,
      region,
      drafts,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 09: await-approval ────────────────────────────────────────────────
const awaitApprovalStep = createStep({
  id: 'await-approval',
  description: 'Wstrzymuje workflow do czasu zatwierdzenia/odrzucenia draftów przez człowieka.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  suspendSchema: z.object({
    drafts: z.array(draftSchema),
    message: z.string(),
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
    rejectedDraftIds: z.array(z.string()).optional(),
    feedback: z.string().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    approved: z.boolean(),
    feedback: z.string(),
  }),
  execute: async (context) => {
    const { taskId, region, drafts } = context.inputData;

    if (context.resumeData) {
      const { approved, rejectedDraftIds = [], feedback } = context.resumeData;
      const filtered = approved
        ? drafts.filter((d) => !rejectedDraftIds.includes(d.draftId))
        : [];
      return { taskId, region, drafts: filtered, approved, feedback: feedback ?? '' };
    }

    if (drafts.length === 0) {
      return { taskId, region, drafts: [], approved: false, feedback: 'Brak draftów.' };
    }

    // Persist approval request do MongoDB (kompatybilne z dashboardem jarvis).
    try {
      const db = await getDb();
      await db.collection('approvals').insertOne({
        id: `producer-hunt-${taskId}`,
        kind: 'producer-hunt-drafts',
        taskId,
        region,
        status: 'pending',
        draftCount: drafts.length,
        drafts: drafts.map((d) => ({
          draftId: d.draftId,
          email: d.email,
          company: d.company,
          subject: d.subject,
        })),
        createdAt: new Date(),
      });
    } catch (err) {
      console.warn(
        `[producer-hunt:${taskId}] persist approval fail:`,
        (err as Error).message,
      );
    }

    return context.suspend(
      {
        drafts,
        message: `Zatwierdź ${drafts.length} cold-email draftów producentów (region=${region}). W rejectedDraftIds podaj draftId tych do pominięcia.`,
      },
      { resumeLabel: 'Zatwierdź drafty' },
    );
  },
});

// ── Step 10: send-on-approve ───────────────────────────────────────────────
const sendOnApproveStep = createStep({
  id: 'send-on-approve',
  description: 'Wysyła zaakceptowane drafty przez gmail.sendDraft. Aktualizuje status w CRM.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    approved: z.boolean(),
    feedback: z.string(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    sentCount: z.number(),
    skippedCount: z.number(),
    approved: z.boolean(),
  }),
  execute: async (context) => {
    const { taskId, drafts, approved } = context.inputData;
    if (!approved || drafts.length === 0) {
      console.log(
        `[producer-hunt:${taskId}] send-on-approve: approved=${approved}, drafts=${drafts.length} → skip.`,
      );
      return { taskId, sentCount: 0, skippedCount: drafts.length, approved };
    }
    const db = await getDb();
    let gmail: GmailService | null = null;
    let sent = 0;
    let skipped = 0;
    for (const draft of drafts) {
      if (!draft.gmailDraftId) {
        console.warn(`[producer-hunt:${taskId}] brak gmailDraftId dla ${draft.email} → skip`);
        skipped++;
        continue;
      }
      try {
        gmail ??= await GmailService.create();
        await gmail.sendDraft(draft.gmailDraftId);
        await db.collection('leads').updateOne(
          { email: draft.email },
          {
            $set: { status: 'email_sent', sentAt: new Date(), updatedAt: new Date() },
            $push: {
              history: {
                action: 'email_sent',
                description: `Wysłano draft ${draft.draftId}.`,
                agentId: 'marketing-agent',
                ts: new Date(),
              },
            } as never,
          },
        );
        sent++;
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] sendDraft fail ${draft.email}:`,
          (err as Error).message,
        );
        skipped++;
      }
    }
    // Mark approval record as completed
    try {
      await db.collection('approvals').updateOne(
        { id: `producer-hunt-${taskId}` },
        { $set: { status: 'approved', completedAt: new Date(), sentCount: sent } },
      );
    } catch {
      /* swallow */
    }
    return { taskId, sentCount: sent, skippedCount: skipped, approved: true };
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────
export const producerHuntWorkflow = createWorkflow({
  id: 'producer-hunt',
  description:
    'Wyszukuje producentów (10-step): discovery → research-only → enrichment → email-extraction → draft → gmail-draft → save-fs → update-crm → approval → send.',
  inputSchema: z.object({
    region: z.string(),
    count: z.number().default(10),
    productType: z.string().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    sentCount: z.number(),
    skippedCount: z.number(),
    approved: z.boolean(),
  }),
})
  .then(discoverLeadsStep)
  .then(createResearchLeadsStep)
  .then(enrichLeadsStep)
  .then(extractEmailsStep)
  .then(draftColdEmailsStep)
  .then(createGmailDraftsStep)
  .then(saveDraftsFsStep)
  .then(updateCrmStep)
  .then(awaitApprovalStep)
  .then(sendOnApproveStep);

producerHuntWorkflow.commit();
