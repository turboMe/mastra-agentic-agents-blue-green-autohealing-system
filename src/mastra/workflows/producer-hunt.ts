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
import { searchWebTool, findCompanyLinksTool } from '../tools/search/tavily.js';
import { 
  knowledgeQueryTool, 
  knowledgeCreateNotebookTool, 
  knowledgeAddSourceTool, 
  knowledgeDeleteNotebookTool 
} from '../tools/knowledge/knowledge-tools.js';

// ── Schemas ─────────────────────────────────────────────────────────────────
const leadSchema = z.object({
  company: z.string(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
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

const isValidEmail = (e?: string | null): e is string =>
  !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const tryParseJson = <T = unknown>(text: string): T | null => {
  try {
    // 1. Spróbuj wyciągnąć z markdown code block
    const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
    if (match) return JSON.parse(match[1]);

    // 2. Jeśli nie ma bloków, spróbuj znaleźć pierwszy '{' i ostatni '}'
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }

    // 3. Fallback do bezpośredniego parsu
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ── Step 01: discover-leads ─────────────────────────────────────────────────
const discoverLeadsStep = createStep({
  id: 'discover-leads',
  description: 'Wyszukuje lokalnych producentów w zadanym regionie (NotebookLM-driven discovery).',
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
    const { region, count, productType } = context.inputData;
    console.log(`[producer-hunt:${taskId}] discover-leads region=${region} spec=${productType ?? 'all'}`);

    // 1. Multi-Search (rozszerzona lista kategorii)
    const baseQueries = [
      `producenci ${productType ?? 'żywności'} ${region} kontakt email`,
      `lokalni dostawcy do restauracji ${region} ${productType ?? ''}`,
      `gospodarstwo rolne ${region} sprzedaż bezpośrednia do restauracji`,
      `rolniczy handel detaliczny ${region} ${productType ?? ''} lista kontakt`,
      `zakład przetwórstwa spożywczego ${region} ${productType ?? ''} www`,
    ];

    const nicheQueries = !productType ? [
      `sery rzemieślnicze nabiał kozi owczy ${region} producent`,
      `wędliny ekologiczne rzemieślnicze masarnia ${region}`,
      `tłocznia soków przetwory owoce warzywa ${region} kontakt`,
      `piekarnia rzemieślnicza chleb na zakwasie ${region} producent`,
      `produkty regionalne certyfikowane ${region} producenci`,
    ] : [];

    const queries = [...baseQueries, ...nicheQueries];

    console.log(`[producer-hunt:${taskId}] multi-search start (${queries.length} queries)`);
    const searchResults = await Promise.all(
      queries.map(q => searchWebTool.execute!({ query: q, maxResults: 5 }, {} as any))
    );
    
    // Konsolidacja i deduplikacja wyników po URL
    const allResults = searchResults.flatMap(r => (r && 'success' in r && r.success) ? r.results : []);
    const uniqueResults = Array.from(new Map(allResults.map(r => [r.url, r])).values());

    // Wybieramy top 12 najbardziej obiecujących linków (pominając social media dla lepszej jakości źródeł)
    const topUrls = uniqueResults
      .filter(r => !r.url.includes('facebook.com') && !r.url.includes('linkedin.com') && !r.url.includes('instagram.com'))
      .slice(0, 12);

    console.log(`[producer-hunt:${taskId}] total unique links: ${uniqueResults.length}, using top ${topUrls.length} for NotebookLM.`);

    let leads: Lead[] = [];
    let notebookId = '';

    try {
      // 2. Notatnik Odkrywcy w NotebookLM
      console.log(`[producer-hunt:${taskId}] tworzę Discovery Notebook...`);
      const createRes = await knowledgeCreateNotebookTool.execute!({ title: `Discovery: Producers ${region} (${taskId})` }, {} as any);
      if (createRes && 'success' in createRes && createRes.success) {
        notebookId = (createRes as any).notebookId;
        
        // Dodawanie źródeł równolegle
        console.log(`[producer-hunt:${taskId}] dodaję ${topUrls.length} źródeł do NotebookLM...`);
        await Promise.all(
          topUrls.map(url => knowledgeAddSourceTool.execute!({
            notebook: notebookId,
            sourceType: 'url',
            url: url.url,
            title: url.title
          }, {} as any))
        );

        // Czekamy chwilę na indeksowanie (NotebookLM potrzebuje czasu)
        console.log(`[producer-hunt:${taskId}] czekam 10s na indeksowanie...`);
        await new Promise(resolve => setTimeout(resolve, 10000));

        const discoveryQuestion = `Na podstawie załadowanych źródeł, sporządź listę do ${count} lokalnych producentów żywności z województwa ${region}.
        Specjalizacja: ${productType ?? 'ogólna (nabiał, mięso, warzywa, sery, przetwory)'}.

        Dla każdego producenta wyciągnij:
        1. company: Pełna nazwa firmy
        2. email: Adres e-mail (bardzo ważne, szukaj w stopkach, kontaktach)
        3. website: Strona WWW
        4. reason: Krótki opis (1 zdanie) co konkretnie produkują.

        Zwróć WYŁĄCZNIE JSON w formacie: { "leads": [{ "company": "...", "email": "...", "website": "...", "reason": "..." }] }
        Pomiń portale ogólne, bazy firm i sklepy pośredniczące. Skup się na REALNYCH wytwórcach.`;

        console.log(`[producer-hunt:${taskId}] odpytuję NotebookLM o listę leadów...`);
        const queryRes = await knowledgeQueryTool.execute!({
          notebook: notebookId,
          question: discoveryQuestion,
          timeout: 180
        }, {} as any);

        if (queryRes && 'success' in queryRes && queryRes.success) {
          const answer = (queryRes as any).answer || '';
          const parsed = tryParseJson<{ leads?: Lead[] } | Lead[]>(answer);
          if (Array.isArray(parsed)) leads = parsed;
          else if (parsed && Array.isArray(parsed.leads)) leads = parsed.leads;
        }
      }
    } catch (err) {
      console.warn(`[producer-hunt:${taskId}] NotebookLM discovery fail:`, (err as Error).message);
    } finally {
      if (notebookId) {
        await knowledgeDeleteNotebookTool.execute!({ notebookId }, {} as any).catch(() => {});
      }
    }

    // Fallback do LLM snippets jeśli NotebookLM zawiódł lub zwrócił mało wyników
    if (leads.length < 2) {
      console.log(`[producer-hunt:${taskId}] NotebookLM zwrócił za mało wyników (${leads.length}), używam fallbacku przez snippets...`);
      const searchContext = uniqueResults.slice(0, 20).map(r => `[${r.title}](${r.url}): ${r.content.slice(0, 400)}`).join('\n\n');
      const fallbackPrompt = `Na podstawie snippetów, wybierz ${count} producentów żywności z ${region}.\n\n${searchContext}\n\nZwróć JSON: { "leads": [...] }`;
      const res = await marketingAgent.generate(fallbackPrompt);
      const parsed = tryParseJson<{ leads?: Lead[] } | Lead[]>(res.text);
      const fallbackLeads = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.leads) ? parsed.leads : []);
      leads = [...leads, ...fallbackLeads];
    }

    // Ostateczna deduplikacja i walidacja
    const seen = new Set();
    leads = leads.filter(l => {
      if (!l.company || l.company.length < 3) return false;
      const normalized = l.company.toLowerCase().trim();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    }).slice(0, count);

    console.log(`[producer-hunt:${taskId}] discover-leads finished, found ${leads.length} leads.`);
    return { taskId, region, leads };
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
    // Przepuszczamy wszystkie leady które mają nazwę firmy. 
    // Nawet jeśli nie mają maila/www - krok enrichment spróbuje je doszukać.
    const validLeads = leads.filter((l) => l.company && l.company.length > 2);
    
    // Do researchu trafiają te, które nie mają poprawnego maila (nawet jeśli mają stronę WWW)
    const researchOnly = leads.filter((l) => !isValidEmail(l.email));
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
              discoveryReason: lead.reason,
              taskId,
            },
          },
          $setOnInsert: { createdAt: new Date(), id: `research-${randomUUID().slice(0, 8)}` },
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
  description: 'Pogłębiony research firm (zwraca personalizationHook do drafterów) z użyciem NotebookLM.',
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

    // Pobierz ogólny kontekst rynkowy z NotebookLM (jeśli dostępny)
    let marketContext = '';
    try {
      const marketQuery = await knowledgeQueryTool.execute!({
        notebook: 'rynek',
        question: `Jakie są najważniejsze trendy i wyzwania dla lokalnych producentów żywności w regionie ${region}?`,
      }, {} as any);
      if (marketQuery && 'success' in marketQuery && marketQuery.success) {
        marketContext = (marketQuery as any).answer ?? '';
      }
    } catch (e) {
      console.warn(`[producer-hunt:${taskId}] NotebookLM 'rynek' niedostępny.`);
    }

    for (const lead of validLeads) {
      console.log(`[producer-hunt:${taskId}] enriching lead: ${lead.company}...`);
      let notebookId = '';
      try {
        // 1. Szukanie linków i głębszego kontekstu przez Tavily
        const linksResult = await findCompanyLinksTool.execute!({
          companyName: lead.company,
          region,
        }, {} as any);

        const isSuccess = linksResult && 'success' in linksResult && linksResult.success;
        const leadContext = isSuccess ? (linksResult as any).searchContext : '';
        const website = isSuccess ? ((linksResult as any).website ?? lead.website) : lead.website;

        let nlmAnalysis = '';
        let nlmHook = '';

        // 2. Jeśli mamy stronę, robimy DEEP research przez NotebookLM
        if (website && website.startsWith('http')) {
          try {
            console.log(`[producer-hunt:${taskId}] creating Deep Research notebook for ${lead.company}...`);
            const createRes = await knowledgeCreateNotebookTool.execute!({ title: `Deep: ${lead.company} (${taskId})` }, {} as any);
            if (createRes && 'success' in createRes && createRes.success) {
              notebookId = (createRes as any).notebookId;

              // Dodajemy stronę firmy jako główne źródło
              await knowledgeAddSourceTool.execute!({
                notebook: notebookId,
                sourceType: 'url',
                url: website,
                title: `Strona: ${lead.company}`
              }, {} as any);

              // Opcjonalnie: dodaj wyniki z Tavily jako tekst
              if (leadContext) {
                await knowledgeAddSourceTool.execute!({
                  notebook: notebookId,
                  sourceType: 'text',
                  text: leadContext,
                  title: `Search context for ${lead.company}`
                }, {} as any);
              }

              // Czekamy na indeksowanie
              await new Promise(resolve => setTimeout(resolve, 8000));

              const researchQuestion = `Przeanalizuj firmę "${lead.company}". Co ich wyróżnia? 
              1. Jakie konkretnie produkty wytwarzają?
              2. Czy mają jakąś historię (rodzinna tradycja, lata istnienia)?
              3. Czy otrzymali jakieś nagrody lub certyfikaty (np. "Produkt Lokalny", RHD)?
              4. Jakie są ich wartości (ekologia, naturalne składniki, brak konserwantów)?

              Na tej podstawie przygotuj:
              - PERSONALIZATION_HOOK: Jedno zdanie (maks 20 słów), które udowodni, że znamy ich firmę. Powinno być naturalne i konkretne (np. "Widziałem, że Wasze sery kozie zdobyły nagrodę na festiwalu w Lublinie").
              - DEEP_ANALYSIS: Kilka zdań podsumowania o ich skali, asortymencie i tym, co moglibyśmy im zaproponować w GastroBridge.`;

              const queryRes = await knowledgeQueryTool.execute!({
                notebook: notebookId,
                question: researchQuestion
              }, {} as any);

              if (queryRes && 'success' in queryRes && queryRes.success) {
                const answer = (queryRes as any).answer || '';
                nlmHook = answer.match(/PERSONALIZATION_HOOK:\s*(.*)/)?.[1]?.trim() || '';
                nlmAnalysis = answer.match(/DEEP_ANALYSIS:\s*(.*)/s)?.[1]?.trim() || answer;
              }
            }
          } catch (nlmErr) {
            console.warn(`[producer-hunt:${taskId}] NLM Deep Research failed for ${lead.company}:`, (nlmErr as Error).message);
          } finally {
            if (notebookId) await knowledgeDeleteNotebookTool.execute!({ notebookId }, {} as any).catch(() => {});
          }
        }

        // 3. Finalne szlifowanie przez marketingAgent (jeśli NLM nie dał pełnych danych)
        const prompt = `Dokończ research firmy "${lead.company}".
Strona: ${website ?? 'nieznana'}. 
Oryginalny powód: ${lead.reason ?? 'lokalny producent'}.

Dane z głębokiego researchu (NLM):
${nlmAnalysis || 'Brak.'}
Hook z NLM: ${nlmHook || 'Brak.'}

Kontekst rynkowy:
${marketContext}

Wyniki wyszukiwania (snippets):
${leadContext}

Zwróć WYŁĄCZNIE JSON:
{ 
  "personalizationHook": "Finalny 1-2 zdaniowy hook do maila (użyj danych z NLM jeśli są dobre, lub wygeneruj nowy konkretny)",
  "rawAnalysis": "Podsumowanie: co produkują, certyfikaty, potencjał współpracy",
  "website": "...",
  "linkedIn": "...",
  "facebook": "..."
}`;

        const res = await marketingAgent.generate(prompt);
        const parsed = tryParseJson<{ 
          personalizationHook?: string; 
          rawAnalysis?: string;
          website?: string;
          linkedIn?: string;
          facebook?: string;
        }>(res.text);

        const rawAnalysis = parsed?.rawAnalysis || nlmAnalysis || leadContext || 'Brak głębokiego researchu.';
        const personalizationHook = parsed?.personalizationHook || nlmHook || `Producent żywności z regionu ${region}.`;

        enriched.push({
          ...lead,
          website: parsed?.website ?? website,
          personalizationHook,
          rawAnalysis,
        });
      } catch (err) {
        console.warn(`[producer-hunt:${taskId}] enrichment fail dla ${lead.company}:`, (err as Error).message);
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
          // Nie usuwamy leada! Idzie dalej, ale bez maila nie powstanie draft.
          console.warn(`[producer-hunt:${taskId}] brak emaila dla ${lead.company} — zapiszę w CRM jako do researchu.`);
          out.push(lead); 
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
  description: 'Pisze spersonalizowane maile na podstawie enrichmentu i zasad Patryka.',
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
      if (!isValidEmail(lead.email)) {
        console.log(`[producer-hunt:${taskId}] skip drafting for ${lead.company} (no email)`);
        continue;
      }

      console.log(`[producer-hunt:${taskId}] drafting email for ${lead.company} (${lead.email})...`);

      const prompt = `Jesteś Patrykiem, chefem który koduje i buduje GastroBridge. 
Napisz krótki, profesjonalny cold-email do producenta: "${lead.company}".

KONTEKST O FIRMIE (Deep Research):
${lead.rawAnalysis}

DEDYKOWANY HOOK:
${lead.personalizationHook}

ZASADY PATRYKA:
1. Maksymalnie 4 zdania. Konkret, zero "waty" sprzedażowej.
2. ZERO emoji. Profesjonalny, ale bezpośredni ton.
3. Cel: Zaproponowanie krótkiej rozmowy o dostawach bezpośrednich do restauracji przez GastroBridge (skrócenie łańcucha dostaw, lepsze marże dla nich). Wspomnij, że obecnie prowadzimy darmowy pilotaż dla wybranych producentów (zaznacz, że jest darmowy tylko w ramach trwającego pilotażu).
4. Hook musi być na samym początku.

ZASADY PERSONALIZACJI:
1. Wykorzystaj minimum dwa konkretne elementy z researchu, aby pokazać, że znasz firmę:
   - konkretny produkt lub kategorię (np. "Wasze sery kozie"),
   - region lub miejscowość,
   - odniesienie do informacji ze strony WWW lub sukcesu firmy.

WYMOGI PRAWNE (RODO):
1. Nie obiecuj wysyłki oferty ani cennika bez zgody odbiorcy.
2. Nie sugeruj, że kontakt pochodzi z kupionej listy (zawsze odnoś się do researchu).
3. Na końcu maila (po podpisie) dodaj obowiązkową stopkę:
   ---
   Administratorem danych jest GastroBridge. Cel: Nawiązanie relacji B2B. Źródło: Publiczne dane z sieci (research). Odpisz "NIE", aby usunąć dane.

Zwróć WYŁĄCZNIE JSON: { "subject": "Temat maila", "body": "Treść maila" }`;

      try {
        const res = await marketingAgent.generate(prompt);
        const parsed = tryParseJson<{ subject?: string; body?: string }>(res.text);
        
        if (parsed?.subject && parsed?.body) {
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
      } catch (err) {
        console.warn(`[producer-hunt:${taskId}] draft fail ${lead.company}:`, (err as Error).message);
      }
    }
    
    console.log(`[producer-hunt:${taskId}] generated ${drafts.length} drafts.`);
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
