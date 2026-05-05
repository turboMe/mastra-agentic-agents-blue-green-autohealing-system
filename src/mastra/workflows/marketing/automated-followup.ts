/**
 * Workflow: automated-followup
 * Sprawdza leady bez odpowiedzi od X dni, generuje follow-up drafty.
 * Etap 6 – marketing workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { marketingAgent } from '../../agents/marketing-agent';
import { getDb } from '../../lib/mongo';

const findStaleLeadsStep = createStep({
  id: 'find-stale-leads',
  description: 'Wyszukuje leady, które nie odpowiedziały od podanej liczby dni.',
  inputSchema: z.object({
    daysWithoutResponse: z.number().default(7),
    maxLeads: z.number().default(10),
    status: z.string().default('sent'),
  }),
  outputSchema: z.object({
    staleLeads: z.array(z.object({
      id: z.string(),
      companyName: z.string(),
      email: z.string(),
      contactName: z.string().optional(),
      lastInteractionAt: z.string(),
      daysStale: z.number(),
      metadata: z.any(),
    })),
    count: z.number(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const cutoff = new Date(Date.now() - context.inputData.daysWithoutResponse * 24 * 3600 * 1000);

    const leads = await db.collection('leads')
      .find({
        status: context.inputData.status,
        lastInteractionAt: { $lt: cutoff },
        email: { $exists: true, $ne: null },
      })
      .sort({ lastInteractionAt: 1 })
      .limit(context.inputData.maxLeads)
      .toArray();

    const staleLeads = leads.map(l => ({
      id: l.id ?? String(l._id),
      companyName: l.companyName ?? '',
      email: l.email ?? '',
      contactName: l.contactName,
      lastInteractionAt: l.lastInteractionAt?.toISOString() ?? '',
      daysStale: Math.floor((Date.now() - new Date(l.lastInteractionAt ?? 0).getTime()) / (24 * 3600 * 1000)),
      metadata: l.metadata ?? {},
    }));

    return { staleLeads, count: staleLeads.length };
  },
});

const generateFollowupDraftsStep = createStep({
  id: 'generate-followup-drafts',
  description: 'Marketing Agent generuje personalizowane follow-up drafty.',
  inputSchema: z.object({
    staleLeads: z.array(z.object({
      id: z.string(),
      companyName: z.string(),
      email: z.string(),
      contactName: z.string().optional(),
      lastInteractionAt: z.string(),
      daysStale: z.number(),
      metadata: z.any(),
    })),
    count: z.number(),
  }),
  outputSchema: z.object({
    drafts: z.array(z.object({
      leadId: z.string(),
      email: z.string(),
      subject: z.string(),
      body: z.string(),
    })),
    generatedCount: z.number(),
  }),
  execute: async (context) => {
    if (context.inputData.count === 0) {
      return { drafts: [], generatedCount: 0 };
    }

    const prompt = `Jesteś Patrykiem z GastroBridge. Wygeneruj follow-up emaile dla ${context.inputData.count} leadów.

## Leady bez odpowiedzi:
${context.inputData.staleLeads.map(l =>
  `- **${l.companyName}** (${l.email}) — ${l.daysStale} dni bez odpowiedzi. ${l.contactName ? `Kontakt: ${l.contactName}.` : ''} ${l.metadata?.draft?.subject ? `Poprzedni temat: "${l.metadata.draft.subject}"` : ''}`
).join('\n')}

## Zadanie
Dla KAŻDEGO leada wygeneruj krótki (3-4 zdania) follow-up. Ton: naturalny, nienatarczywy, skoncentrowany na wartości GastroBridge.
Zwróć JSON: { "drafts": [{ "leadId": "...", "email": "...", "subject": "...", "body": "..." }] }`;

    const result = await marketingAgent.generate(prompt);
    let drafts: Array<{ leadId: string; email: string; subject: string; body: string }> = [];

    try {
      const match = result.text.match(/```(?:json)?\n?([\s\S]*?)```/);
      const jsonStr = match ? match[1] : result.text;
      const parsed = JSON.parse(jsonStr);
      drafts = parsed.drafts ?? [];
    } catch {
      console.warn('[automated-followup] Nie udało się sparsować JSON z LLM');
    }

    // Inject emails from leads map if missing
    const emailMap = Object.fromEntries(context.inputData.staleLeads.map(l => [l.id, l.email]));
    drafts = drafts.map(d => ({ ...d, email: d.email || emailMap[d.leadId] || '' }));

    return { drafts, generatedCount: drafts.length };
  },
});

const saveDraftsStep = createStep({
  id: 'save-followup-drafts',
  description: 'Zapisuje wygenerowane follow-up drafty w metadata leadów.',
  inputSchema: z.object({
    drafts: z.array(z.object({
      leadId: z.string(),
      email: z.string(),
      subject: z.string(),
      body: z.string(),
    })),
    generatedCount: z.number(),
  }),
  outputSchema: z.object({
    savedCount: z.number(),
    leadIds: z.array(z.string()),
  }),
  execute: async (context) => {
    const db = await getDb();
    let savedCount = 0;
    const leadIds: string[] = [];
    const now = new Date();

    for (const draft of context.inputData.drafts) {
      await db.collection('leads').updateOne(
        { id: draft.leadId },
        {
          $set: {
            status: 'draft_gotowy',
            'metadata.followup_draft': { subject: draft.subject, body: draft.body },
            updatedAt: now,
            lastInteractionAt: now,
          },
          $push: {
            history: {
              timestamp: now,
              action: 'followup_draft_created',
              description: `Follow-up draft: ${draft.subject}`,
              agentId: 'automated-followup-workflow',
            } as any,
          },
        },
      );
      savedCount++;
      leadIds.push(draft.leadId);
    }

    return { savedCount, leadIds };
  },
});

export const automatedFollowupWorkflow = createWorkflow({
  id: 'automated-followup',
  description: 'Wyszukuje leady bez odpowiedzi i generuje personalizowane follow-up drafty.',
  inputSchema: z.object({
    daysWithoutResponse: z.number().default(7),
    maxLeads: z.number().default(10),
    status: z.string().default('sent'),
  }),
  outputSchema: z.object({
    savedCount: z.number(),
    leadIds: z.array(z.string()),
  }),
})
  .then(findStaleLeadsStep)
  .then(generateFollowupDraftsStep)
  .then(saveDraftsStep);

automatedFollowupWorkflow.commit();
