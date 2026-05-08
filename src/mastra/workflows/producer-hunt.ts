/**
 * Producer-hunt workflow (10 stepów) — port z jarvis
 * (apps/workers/src/agents/marketing-agent: outreach.ts, enrichment.ts, drafting.ts, index.ts).
 *
 * Mapowanie steps → jarvis (per plan §8.1):
 *   01 discover-leads          ← steps/outreach.ts (Tavily/NotebookLM + fallback LLM)
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
 * więc enrichment używa fallbacku przez LLM zamiast pełnego deep research, gdy NLM nie wystarczy.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  producerHuntDiscoveryAgent,
  producerHuntDraftAgent,
  producerHuntEmailExtractionAgent,
  producerHuntEnrichmentAgent,
  producerHuntJsonRepairAgent,
  producerHuntCloudFallbackAgent,
} from '../agents/marketing-agent';
import { workflowModels } from '../config/workflow-models.js';
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
import { 
  normalizeTextField, 
  normalizeNullableString, 
  generateJsonWithFallback,
  assertSafeProducerHuntModel
} from './producer-hunt/helpers.js';
import {
  scoreLead,
  validateEnrichmentIdentity,
  validateDraft,
  normalizeOptionalText,
  mapToCrmSegment,
  ACCEPTABLE_SUPPLIER_TYPES,
  getRegionTokens,
  type SupplierType,
} from './producer-hunt/quality.js';
import {
  DISCOVERY_PROFILES,
  EXCLUDED_DOMAIN_HINTS,
  SOCIAL_AND_NLM_INCOMPATIBLE_HINTS,
  TAVILY_QUERY_BUDGET,
  MAX_QUERIES_PER_PROFILE_ROUND_1,
} from './producer-hunt/discovery-queries.js';
import {
  defaultHookForType,
  additionalSourcePathsForType,
  additionalSearchQueryForType,
  researchQuestionFor,
  finalEnrichmentPromptFor,
} from './producer-hunt/enrichment-prompts.js';

// ── Schemas ─────────────────────────────────────────────────────────────────
const supplierTypeSchema = z.enum([
  'producer',
  'manufacturer',
  'cooperative',
  'producer_group',
  'wholesaler',
  'distributor',
  'importer',
  'farm_aggregator',
  'unknown',
]);

const directToHorecaSchema = z.enum(['yes', 'limited', 'no', 'unknown']);

const leadSchema = z.object({
  company: z.string(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  productCategory: z.string().nullable().optional(),
  sourceUrls: z.union([z.array(z.string()), z.string()]).nullable().optional(),
  emailSource: z.string().nullable().optional(),
  isProducer: z.boolean().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  supplierType: supplierTypeSchema.nullable().optional(),
  directToHoreca: directToHorecaSchema.nullable().optional(),
  servesRegions: z.array(z.string()).nullable().optional(),
  brandsOrPortfolio: z.array(z.string()).nullable().optional(),
});
type Lead = z.infer<typeof leadSchema>;

const enrichedLeadSchema = leadSchema.extend({
  rawAnalysis: z.string(),
  personalizationHook: z.string(),
  companyName: z.string().nullable().optional(),
  inferredSupplierType: supplierTypeSchema.optional(),
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

const qualitySummarySchema = z.object({
  discovered: z.number(),
  draftCandidates: z.number(),
  researchNeeded: z.number(),
  rejected: z.number(),
  candidatesForResearch: z.number(),
});

const postResearchSummarySchema = z.object({
  inputCandidates: z.number(),
  enrichedAccepted: z.number(),
  enrichedRejected: z.number(),
});

// New schemas for LLM responses
const enrichmentResponseSchema = z.object({
  companyName: z.string().optional().nullable(),
  supplierType: supplierTypeSchema.optional(),
  directToHoreca: directToHorecaSchema.optional(),
  brandsOrPortfolio: z.array(z.string()).optional().default([]),
  servesRegions: z.array(z.string()).optional().default([]),
  personalizationHook: z.string().min(5),
  rawAnalysis: z.union([
    z.string(),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
  ]).optional(),
  website: z.string().optional().nullable(),
  linkedIn: z.string().optional().nullable(),
  facebook: z.string().optional().nullable(),
  identityConfidence: z.number().min(0).max(1).optional(),
  identityWarning: z.string().optional(),
});

const draftResponseSchema = z.object({
  subject: z.string().min(5).max(120),
  body: z.string().min(200),
});

const discoveryResponseSchema = z.object({
  leads: z.array(leadSchema).default([]),
});

const isValidEmail = (e?: string | null): e is string =>
  !!normalizeOptionalText(e) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeOptionalText(e)!);

const normalizeSourceUrls = (value: unknown): string[] | undefined => {
  if (!value) return undefined;
  const values = Array.isArray(value)
    ? value
    : String(value).split(/[\n,;]/);
  const normalized = values
    .map((url) => normalizeOptionalText(String(url)))
    .filter((url): url is string => !!url);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'tak', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'nie', 'no', '0'].includes(normalized)) return false;
  return undefined;
};

const normalizeConfidence = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : undefined;
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!value) return undefined;
  const values = Array.isArray(value) ? value : String(value).split(/[\n,;]/);
  const normalized = values
    .map((item) => normalizeOptionalText(String(item)))
    .filter((item): item is string => !!item);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeSupplierType = (value: unknown): SupplierType | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const allowed: SupplierType[] = [
    'producer', 'manufacturer', 'cooperative', 'producer_group',
    'wholesaler', 'distributor', 'importer', 'farm_aggregator', 'unknown',
  ];
  return allowed.includes(normalized as SupplierType) ? (normalized as SupplierType) : undefined;
};

const normalizeDirectToHoreca = (value: unknown): 'yes' | 'limited' | 'no' | 'unknown' | undefined => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['yes', 'tak', 'true', '1'].includes(normalized)) return 'yes';
  if (['no', 'nie', 'false', '0'].includes(normalized)) return 'no';
  if (['limited', 'czesciowo', 'częściowo', 'partial'].includes(normalized)) return 'limited';
  if (['unknown', 'nieznane', 'nieznany'].includes(normalized)) return 'unknown';
  return undefined;
};

const normalizeLead = (lead: Lead): Lead => ({
  company: lead.company.trim(),
  email: normalizeOptionalText(lead.email),
  website: normalizeOptionalText(lead.website),
  reason: normalizeOptionalText(lead.reason),
  city: normalizeOptionalText(lead.city),
  productCategory: normalizeOptionalText(lead.productCategory),
  sourceUrls: normalizeSourceUrls(lead.sourceUrls),
  emailSource: normalizeOptionalText(lead.emailSource),
  isProducer: normalizeBoolean(lead.isProducer),
  confidence: normalizeConfidence(lead.confidence),
  supplierType: normalizeSupplierType(lead.supplierType),
  directToHoreca: normalizeDirectToHoreca(lead.directToHoreca),
  servesRegions: normalizeStringArray(lead.servesRegions),
  brandsOrPortfolio: normalizeStringArray(lead.brandsOrPortfolio),
});

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
    supplierTypes: z.array(supplierTypeSchema).optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    leads: z.array(leadSchema),
    acceptableSupplierTypes: z.array(supplierTypeSchema),
  }),
  execute: async (context) => {
    const taskId = `producer-hunt-${randomUUID().slice(0, 8)}`;
    const { region, count, productType, supplierTypes } = context.inputData;
    const acceptableSupplierTypes = (supplierTypes && supplierTypes.length > 0
      ? supplierTypes.filter((t) => t !== 'unknown')
      : ACCEPTABLE_SUPPLIER_TYPES) as SupplierType[];
    console.log(`[producer-hunt:${taskId}] discover-leads region=${region} spec=${productType ?? 'all'} types=${acceptableSupplierTypes.join(',')}`);

    // Preflight checks
    const models = workflowModels.producerHunt;
    assertSafeProducerHuntModel(models.discovery, 'discovery', taskId);
    assertSafeProducerHuntModel(models.enrichment, 'enrichment', taskId);
    assertSafeProducerHuntModel(models.draftEmail, 'draftEmail', taskId);

    // 1. Multi-profile, multi-round Tavily search z twardym budżetem.
    type SearchHit = { title: string; url: string; content: string; score: number };
    const accumulatedHits = new Map<string, SearchHit>();
    let queriesIssued = 0;

    const runQueries = async (queries: string[], roundLabel: string) => {
      const remaining = Math.max(0, TAVILY_QUERY_BUDGET - queriesIssued);
      const slice = queries.slice(0, remaining);
      if (slice.length === 0) {
        console.log(`[producer-hunt:${taskId}] ${roundLabel}: query budget exhausted`);
        return;
      }
      queriesIssued += slice.length;
      const responses = await Promise.all(
        slice.map((q) => searchWebTool.execute!({ query: q, maxResults: 5 }, {} as any)),
      );
      for (const res of responses) {
        if (!res || !('success' in res) || !res.success) continue;
        for (const hit of res.results as SearchHit[]) {
          if (!accumulatedHits.has(hit.url)) accumulatedHits.set(hit.url, hit);
        }
      }
    };

    const activeProfiles = acceptableSupplierTypes
      .map((t) => DISCOVERY_PROFILES[t as Exclude<SupplierType, 'unknown'>])
      .filter(Boolean);

    // Runda 1: bazowe + niszowe (limit per profil)
    const round1Queries: string[] = [];
    for (const profile of activeProfiles) {
      const base = profile.baseQueries(region, productType);
      const niche = profile.nicheQueries(region, productType);
      const merged = [...base, ...niche].slice(0, MAX_QUERIES_PER_PROFILE_ROUND_1);
      round1Queries.push(...merged);
    }
    console.log(`[producer-hunt:${taskId}] discover round1: ${round1Queries.length} queries across ${activeProfiles.length} profiles`);
    await runQueries(round1Queries, 'discover round1');

    // Runda 2: city-level fallback gdy mamy < count*2 surowych hitów
    if (accumulatedHits.size < count * 2 && queriesIssued < TAVILY_QUERY_BUDGET) {
      const regionTokens = getRegionTokens(region);
      // bierz tylko miasta (skip warianty regionu typu "slask", "slaskie")
      const cities = regionTokens.filter((t) => t.length > 4 && !t.includes('skie') && !t.includes('slask')).slice(0, 4);
      const round2Queries: string[] = [];
      for (const profile of activeProfiles) {
        for (const city of cities) {
          round2Queries.push(...profile.cityQueries(region, city, productType));
        }
      }
      if (round2Queries.length > 0) {
        console.log(`[producer-hunt:${taskId}] discover round2: ${round2Queries.length} city-level queries (cities=${cities.join(',')})`);
        await runQueries(round2Queries, 'discover round2');
      }
    }

    const uniqueResults = Array.from(accumulatedHits.values());

    // Filtr URL przed NotebookLM:
    //  - odrzuć NLM-incompatible (social, video)
    //  - odrzuć B2C marketplaces / sieci handlowe
    //  - dopuść hurtownie/dystrybutorów (nie odrzucamy domen typu hurtownia.pl)
    const isUsableForNotebook = (url: string) => {
      const lower = url.toLowerCase();
      if (SOCIAL_AND_NLM_INCOMPATIBLE_HINTS.some((d) => lower.includes(d))) return false;
      if (EXCLUDED_DOMAIN_HINTS.some((d) => lower.includes(d))) return false;
      return true;
    };

    const topUrls = uniqueResults.filter((r) => isUsableForNotebook(r.url)).slice(0, 12);

    console.log(`[producer-hunt:${taskId}] total unique links: ${uniqueResults.length}, queries issued: ${queriesIssued}/${TAVILY_QUERY_BUDGET}, top ${topUrls.length} → NotebookLM.`);

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

        const acceptableTypesText = acceptableSupplierTypes.join(', ');
        const discoveryQuestion = `Na podstawie załadowanych źródeł, sporządź listę do ${count} firm z województwa ${region},
które mogą dostarczać żywność do restauracji w modelu B2B (cel: GastroBridge).
Specjalizacja: ${productType ?? 'ogólna (nabiał, mięso, warzywa, sery, przetwory, mrożonki, suchy magazyn)'}.

Akceptowane typy dostawcy: ${acceptableTypesText}.
Definicje:
- producer        – producent / wytwórca, gospodarstwo, manufaktura, RHD
- manufacturer    – większy zakład przetwórstwa
- cooperative     – kooperatywa / spółdzielnia
- producer_group  – grupa producencka, zrzeszenie hodowców
- wholesaler      – hurtownia spożywcza, hurtownia HoReCa, cash & carry
- distributor     – dystrybutor regionalny / krajowy do gastronomii (foodservice)
- importer        – importer specjalistyczny (np. produkty włoskie, hiszpańskie, azjatyckie)
- farm_aggregator – platforma agregująca rolników / marketplace producentów
- unknown         – jeśli nie potrafisz dopasować — to też zwróć, oznacz "unknown"

Pomiń:
- portale ogłoszeniowe, katalogi firm (panoramafirm, gowork, pkt.pl, oferteo, aleo);
- duże sieci handlowe B2C (Biedronka, Lidl, Auchan, Tesco, Kaufland, Carrefour);
- restauracje, hotele, pizzerie, bary jako podmiot docelowy (to są nasi klienci, nie dostawcy);
- gigantyczne sieci hurtowe (Selgros, Makro) — można je zostawić dla kontekstu, ale ICP to
  ich potencjalni dostawcy/poddostawcy.

Dla każdej firmy zwróć:
1.  company: Pełna nazwa firmy
2.  supplierType: jeden z typów wyżej
3.  directToHoreca: "yes" | "limited" | "no" | "unknown" — czy sprzedają bezpośrednio do restauracji/hoteli/cateringu
4.  brandsOrPortfolio: lista 2-5 marek lub kategorii w portfolio, jeśli wynika ze źródeł
5.  servesRegions: lista województw / miast zasięgu dostaw, jeśli widać; w razie wątpliwości jedno województwo: ["${region}"]
6.  email: adres e-mail lub null (szukaj w stopkach i podstronach kontaktu)
7.  website: oficjalna strona WWW lub null
8.  city: miasto / miejscowość siedziby
9.  productCategory: konkretna kategoria (np. nabiał, mięso, warzywa, mrożonki, oliwa)
10. sourceUrls: 1-3 źródła potwierdzające typ i ofertę
11. emailSource: skąd pochodzi e-mail, jeśli jest
12. isProducer: true tylko gdy źródło wskazuje realne wytwarzanie. Dla hurtowni/dystrybutorów/importerów — false.
13. confidence: liczba 0-1 — pewność, że firma istnieje i pasuje do typu
14. reason: 1 zdanie — co konkretnie oferują i komu sprzedają

Zasady:
- Nie wpisuj "Brak danych" ani "brak" — używaj null.
- Jeśli firma jest restauracją/hotelem (końcowym konsumentem), nie umieszczaj jej na liście.
- Jeśli widzisz hurtownię HoReCa lub dystrybutora foodservice — DOPISZ JĄ. To są wartościowi
  partnerzy GastroBridge, nie filtruj ich jako "pośredników".
- Jeśli nie potrafisz określić typu — supplierType: "unknown" (lead pójdzie do research_needed,
  ale go nie odrzucamy automatycznie).

Zwróć WYŁĄCZNIE JSON w formacie:
{ "leads": [
  {
    "company": "...",
    "supplierType": "wholesaler",
    "directToHoreca": "yes",
    "brandsOrPortfolio": ["..."],
    "servesRegions": ["..."],
    "email": null,
    "website": null,
    "city": "...",
    "productCategory": "...",
    "sourceUrls": ["..."],
    "emailSource": null,
    "isProducer": false,
    "confidence": 0.8,
    "reason": "..."
  }
] }`;

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
    const minAcceptable = count;
    if (leads.length < minAcceptable) {
      console.log(`[producer-hunt:${taskId}] NotebookLM zwrócił mniej niż target (${leads.length}/${count}), używam fallbacku przez snippets...`);
      const searchContext = uniqueResults.slice(0, 20).map(r => `[${r.title}](${r.url}): ${r.content.slice(0, 400)}`).join('\n\n');
      const fallbackTypesText = acceptableSupplierTypes.join(', ');
      const fallbackPrompt = `Na podstawie poniższych snippetów wybierz do ${count} firm z ${region},
które mogą dostarczać żywność do restauracji w modelu B2B (cel: GastroBridge).

Akceptowane typy dostawcy: ${fallbackTypesText}.
Klasyfikuj każdą firmę do jednego z typów:
- producer / manufacturer (wytwórca / zakład przetwórstwa),
- cooperative / producer_group / farm_aggregator (kooperatywa / grupa / platforma),
- wholesaler (hurtownia HoReCa, cash & carry),
- distributor (dystrybutor foodservice),
- importer (importer specjalistyczny),
- unknown (jeśli nie potrafisz dopasować).

Pomiń:
- katalogi firm i portale ogólne (panoramafirm, gowork, pkt.pl, aleo, oferteo);
- sieci handlowe B2C (Biedronka, Lidl, Auchan, Tesco, Kaufland, Carrefour);
- restauracje, hotele, pizzerie, bary mleczne (to nasi klienci, nie dostawcy).

Nie odrzucaj hurtowni i dystrybutorów — to wartościowi partnerzy GastroBridge.
Nie wpisuj "Brak danych" — używaj null.

Snippety:
${searchContext}

Zwróć WYŁĄCZNIE JSON:
{ "leads": [
  {
    "company": "...",
    "supplierType": "wholesaler",
    "directToHoreca": "yes",
    "brandsOrPortfolio": ["..."],
    "servesRegions": ["..."],
    "email": null,
    "website": null,
    "city": "...",
    "productCategory": "...",
    "sourceUrls": ["..."],
    "emailSource": null,
    "isProducer": false,
    "confidence": 0.7,
    "reason": "..."
  }
] }`;
      
      const res = await generateJsonWithFallback({
        taskId,
        stepId: 'discover-leads-fallback',
        prompt: fallbackPrompt,
        schema: discoveryResponseSchema,
        localAgent: producerHuntDiscoveryAgent,
        repairAgent: producerHuntJsonRepairAgent,
        cloudFallbackAgent: producerHuntCloudFallbackAgent,
        fallback: () => ({ leads: [] }),
      });
      
      leads = [...leads, ...res.leads];
    }

    // Ostateczna deduplikacja i walidacja
    const seen = new Set();
    const normalizedLeads = leads
      .filter((l) => l?.company && l.company.length >= 3)
      .map((l) => normalizeLead(l));

    const finalLeads = normalizedLeads.filter(l => {
      if (!l.company || l.company.length < 3) return false;
      
      // Bardziej agresywna deduplikacja
      const normalizedName = l.company.toLowerCase()
        .replace(/sp\. z o\.o\.|s\.c\.|sp\. j\.|p\.h\.u\.|p\.p\.h\.u\.|spółka|"/g, '')
        .trim();
      
      const emailDomain = l.email && isValidEmail(l.email) ? l.email.split('@')[1].toLowerCase() : null;
      
      const key = emailDomain ? `domain:${emailDomain}` : `name:${normalizedName}`;
      
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, count);

    console.log(`[producer-hunt:${taskId}] discover-leads finished, found ${finalLeads.length} leads.`);
    return { taskId, region, leads: finalLeads, acceptableSupplierTypes };
  },
});

// ── Step 02: create-research-leads ──────────────────────────────────────────
const createResearchLeadsStep = createStep({
  id: 'create-research-leads',
  description:
    'Klasyfikuje leady i przepuszcza draft_candidate oraz research_needed do pogłębionego researchu.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    leads: z.array(leadSchema),
    acceptableSupplierTypes: z.array(supplierTypeSchema),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    validLeads: z.array(leadSchema),
    researchOnlyCount: z.number(),
    qualitySummary: qualitySummarySchema,
    acceptableSupplierTypes: z.array(supplierTypeSchema),
  }),
  execute: async (context) => {
    const { taskId, region, leads, acceptableSupplierTypes } = context.inputData;
    const acceptedTypeSet = new Set<SupplierType>(acceptableSupplierTypes as SupplierType[]);

    // Scoring and filtering
    const scoredLeads = leads.map((l) => {
      const lead = normalizeLead(l);
      const quality = scoreLead(lead, region);

      // propaguj inferredSupplierType do leada (nie nadpisuj declared)
      const enrichedLead: Lead = {
        ...lead,
        supplierType: lead.supplierType ?? quality.inferredSupplierType,
      };

      // jeśli typ jest poza listą akceptowalnych, wymuś reject
      if (!acceptedTypeSet.has(quality.inferredSupplierType)) {
        return {
          lead: enrichedLead,
          quality: {
            ...quality,
            decision: 'reject' as const,
            reasons: [...quality.reasons, `reject: typ ${quality.inferredSupplierType} poza listą akceptowalnych`],
          },
        };
      }

      return { lead: enrichedLead, quality };
    }).sort((a, b) => b.quality.score - a.quality.score);

    // validLeads zostaje nazwą kontraktu workflow, ale teraz oznacza kandydatów
    // do researchu: pewnych i niepewnych, o ile nie są odrzucone.
    const validLeads = scoredLeads
      .filter(sl => sl.quality.decision !== 'reject')
      .map(sl => sl.lead);

    const researchOnly = scoredLeads
      .filter(sl => sl.quality.decision === 'research_needed')
      .map(sl => sl.lead);

    const draftCandidateCount = scoredLeads.filter(sl => sl.quality.decision === 'draft_candidate').length;
    const rejectedCount = scoredLeads.filter(sl => sl.quality.decision === 'reject').length;
    const qualitySummary = {
      discovered: scoredLeads.length,
      draftCandidates: draftCandidateCount,
      researchNeeded: researchOnly.length,
      rejected: rejectedCount,
      candidatesForResearch: validLeads.length,
    };

    // Rozkład typów dla diagnostyki
    const bySupplierType: Record<string, number> = {};
    for (const sl of scoredLeads) {
      const t = sl.quality.inferredSupplierType;
      bySupplierType[t] = (bySupplierType[t] ?? 0) + 1;
    }
    console.log(`[producer-hunt:${taskId}] discovered by type:`, JSON.stringify(bySupplierType));

    const db = await getDb();

    for (const sl of scoredLeads) {
      console.log(
        `[producer-hunt:${taskId}] lead quality ${sl.lead.company}: type=${sl.quality.inferredSupplierType}, decision=${sl.quality.decision}, score=${sl.quality.score}, reasons=${sl.quality.reasons.join('; ')}`,
      );

      if (sl.quality.decision === 'reject') {
        console.log(`[producer-hunt:${taskId}] rejecting lead ${sl.lead.company} (score: ${sl.quality.score}, reasons: ${sl.quality.reasons.join(', ')})`);
        continue;
      }

      const segment = mapToCrmSegment(sl.quality.inferredSupplierType);

      await db.collection('leads').updateOne(
        { companyName: sl.lead.company, region },
        {
          $set: {
            companyName: sl.lead.company,
            segment,
            region,
            status: sl.quality.decision === 'draft_candidate' ? 'research_queued' : 'research_needed',
            website: sl.lead.website,
            updatedAt: new Date(),
            metadata: {
              discoveryReason: sl.lead.reason,
              city: sl.lead.city,
              productCategory: sl.lead.productCategory,
              sourceUrls: sl.lead.sourceUrls,
              emailSource: sl.lead.emailSource,
              isProducer: sl.lead.isProducer,
              confidence: sl.lead.confidence,
              supplierType: sl.quality.inferredSupplierType,
              declaredSupplierType: sl.lead.supplierType,
              directToHoreca: sl.lead.directToHoreca,
              servesRegions: sl.lead.servesRegions,
              brandsOrPortfolio: sl.lead.brandsOrPortfolio,
              qualityScore: sl.quality.score,
              qualityDecision: sl.quality.decision,
              qualityReasons: sl.quality.reasons,
              taskId,
            },
          },
          $setOnInsert: { createdAt: new Date(), id: `research-${randomUUID().slice(0, 8)}` },
        },
        { upsert: true },
      );
    }

    console.log(
      `[producer-hunt:${taskId}] candidates-for-research=${validLeads.length}, research-needed=${researchOnly.length}, draft-candidates=${draftCandidateCount}, rejected=${rejectedCount}`,
    );
    return {
      taskId,
      region,
      validLeads,
      researchOnlyCount: researchOnly.length,
      qualitySummary,
      acceptableSupplierTypes,
    };
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
    qualitySummary: qualitySummarySchema.optional(),
    acceptableSupplierTypes: z.array(supplierTypeSchema).optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enriched: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
    postResearchSummary: postResearchSummarySchema,
  }),
  execute: async (context) => {
    const { taskId, region, validLeads } = context.inputData;
    const enriched: EnrichedLead[] = [];
    let enrichedRejected = 0;

    // Pobierz ogólny kontekst rynkowy z NotebookLM (jeśli dostępny)
    let marketContext = '';
    try {
      const marketQuery = await knowledgeQueryTool.execute!({
        notebook: 'rynek',
        question: `Jakie są najważniejsze trendy i wyzwania dla dostawców żywności (producentów, hurtowni, dystrybutorów) obsługujących HoReCa w regionie ${region}?`,
      }, {} as any);
      if (marketQuery && 'success' in marketQuery && marketQuery.success) {
        marketContext = (marketQuery as any).answer ?? '';
      }
    } catch (e) {
      console.warn(`[producer-hunt:${taskId}] NotebookLM 'rynek' niedostępny.`);
    }

    const db = await getDb();

    for (const lead of validLeads) {
      const declaredOrInferredType: SupplierType = (lead.supplierType as SupplierType | undefined) ?? 'unknown';
      console.log(`[producer-hunt:${taskId}] enriching lead: ${lead.company} (type=${declaredOrInferredType})...`);
      let notebookId = '';
      try {
        // 1. Szukanie linków i głębszego kontekstu przez Tavily
        const linksResult = await findCompanyLinksTool.execute!({
          companyName: lead.company,
          region,
        }, {} as any);

        const isSuccess = linksResult && 'success' in linksResult && linksResult.success;
        let leadContext = isSuccess ? (linksResult as any).searchContext : '';
        const website = normalizeOptionalText(isSuccess ? ((linksResult as any).website ?? lead.website) : lead.website);
        const researchWebsite = website
          ? (website.startsWith('http') ? website : `https://${website}`)
          : null;

        // 1b. Dodatkowe Tavily query per typ (hurtownia/dystrybutor/importer/kooperatywa)
        const extraSearchQuery = additionalSearchQueryForType(declaredOrInferredType, lead.company);
        if (extraSearchQuery) {
          try {
            const extraRes = await searchWebTool.execute!({ query: extraSearchQuery, maxResults: 5 }, {} as any);
            if (extraRes && 'success' in extraRes && extraRes.success) {
              const snippets = extraRes.results.map((r: any) => `[${r.title}](${r.url}): ${r.content.slice(0, 240)}`).join('\n\n');
              leadContext = leadContext ? `${leadContext}\n\n--- Type-specific context (${declaredOrInferredType}) ---\n${snippets}` : snippets;
            }
          } catch (extraErr) {
            console.warn(`[producer-hunt:${taskId}] extra search for ${lead.company} failed:`, (extraErr as Error).message);
          }
        }

        let nlmAnalysis = '';
        let nlmHook = '';

        // 2. Jeśli mamy stronę, robimy DEEP research przez NotebookLM (multi-source per typ)
        if (researchWebsite) {
          try {
            console.log(`[producer-hunt:${taskId}] creating Deep Research notebook for ${lead.company}...`);
            const createRes = await knowledgeCreateNotebookTool.execute!({ title: `Deep: ${lead.company} (${taskId})` }, {} as any);
            if (createRes && 'success' in createRes && createRes.success) {
              notebookId = (createRes as any).notebookId;

              // Dodajemy stronę główną
              await knowledgeAddSourceTool.execute!({
                notebook: notebookId,
                sourceType: 'url',
                url: researchWebsite,
                title: `Strona: ${lead.company}`
              }, {} as any);

              // Multi-source: dodajemy podstrony dopasowane do typu (max 4 ekstra → razem ≤5 URL).
              // NotebookLM toleruje 404, więc nie pre-fetchujemy.
              const extraPaths = additionalSourcePathsForType(declaredOrInferredType).slice(0, 4);
              const baseUrl = researchWebsite.replace(/\/$/, '');
              await Promise.all(
                extraPaths.map((path) =>
                  knowledgeAddSourceTool.execute!({
                    notebook: notebookId,
                    sourceType: 'url',
                    url: `${baseUrl}${path}`,
                    title: `${lead.company} ${path}`,
                  }, {} as any).catch(() => null),
                ),
              );

              // Tavily searchContext jako tekst pomocniczy.
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

              const researchQuestion = researchQuestionFor(declaredOrInferredType, {
                company: lead.company,
                website: researchWebsite,
                city: lead.city ?? null,
                productCategory: lead.productCategory ?? null,
              });

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

        // 3. Finalne szlifowanie przez LLM (per typ)
        const sourceUrls = Array.isArray(lead.sourceUrls) ? lead.sourceUrls.join('\n') : (lead.sourceUrls ?? '');
        const prompt = finalEnrichmentPromptFor({
          supplierType: declaredOrInferredType,
          lead: {
            company: lead.company,
            website,
            city: lead.city ?? null,
            productCategory: lead.productCategory ?? null,
          },
          researchWebsite,
          website,
          sourceUrls,
          reason: lead.reason ?? null,
          nlmAnalysis,
          nlmHook,
          marketContext,
          leadContext,
          region,
        });

        const parsed = await generateJsonWithFallback({
          taskId,
          stepId: 'enrich-leads',
          entityName: lead.company,
          prompt,
          schema: enrichmentResponseSchema,
          localAgent: producerHuntEnrichmentAgent,
          repairAgent: producerHuntJsonRepairAgent,
          cloudFallbackAgent: producerHuntCloudFallbackAgent,
          fallback: () => ({
            companyName: lead.company,
            supplierType: declaredOrInferredType,
            personalizationHook: nlmHook || lead.reason || defaultHookForType(declaredOrInferredType, region),
            rawAnalysis: nlmAnalysis || leadContext || 'Brak głębokiego researchu.',
            website: researchWebsite ?? website,
            identityConfidence: 0.5,
            brandsOrPortfolio: [],
            servesRegions: [],
          }),
        });

        const rawAnalysis = normalizeTextField(
          parsed.rawAnalysis,
          normalizeTextField(nlmAnalysis || leadContext, 'Brak głębokiego researchu.'),
        );

        const personalizationHook = normalizeTextField(
          parsed.personalizationHook,
          nlmHook || defaultHookForType(declaredOrInferredType, region),
        );

        const candidate = {
          ...lead,
          companyName: normalizeOptionalText(parsed.companyName) ?? lead.company,
          website: normalizeNullableString(parsed.website ?? researchWebsite ?? website ?? lead.website),
          personalizationHook,
          rawAnalysis,
          supplierType: parsed.supplierType ?? lead.supplierType,
          directToHoreca: parsed.directToHoreca ?? lead.directToHoreca,
          brandsOrPortfolio: parsed.brandsOrPortfolio ?? lead.brandsOrPortfolio,
          servesRegions: parsed.servesRegions ?? lead.servesRegions,
        };

        // Identity Guardrail
        const identity = validateEnrichmentIdentity(lead, parsed);
        if (!identity.ok || (parsed.identityConfidence && parsed.identityConfidence < 0.5)) {
          console.warn(`[producer-hunt:${taskId}] identity mismatch for ${lead.company}:`, identity.reasons.join(', '));
          // Reset to safe values if identity is doubtful
          candidate.personalizationHook = defaultHookForType(declaredOrInferredType, region);
          candidate.rawAnalysis = `Wstępny research dla ${lead.company}. Wymaga weryfikacji tożsamości. Original analysis: ${rawAnalysis.slice(0, 100)}...`;
        }

        const validation = enrichedLeadSchema.safeParse(candidate);
        if (!validation.success) {
          console.warn(`[producer-hunt:${taskId}] schema repair fallback for ${lead.company}:`, validation.error.message);
          const fallbackCandidate: EnrichedLead = {
            ...lead,
            personalizationHook: defaultHookForType(declaredOrInferredType, region),
            rawAnalysis: 'Błąd walidacji enrichmentu.',
            companyName: lead.company,
          };
          const fallbackQuality = scoreLead(fallbackCandidate, region);
          fallbackCandidate.inferredSupplierType = fallbackQuality.inferredSupplierType;
          await db.collection('leads').updateOne(
            { companyName: lead.company, region },
            {
              $set: {
                status: fallbackQuality.decision === 'reject' ? 'research_rejected' : 'research_enriched',
                segment: mapToCrmSegment(fallbackQuality.inferredSupplierType),
                updatedAt: new Date(),
                'metadata.postResearchQuality': fallbackQuality,
                'metadata.supplierType': fallbackQuality.inferredSupplierType,
              },
            },
          );
          if (fallbackQuality.decision === 'reject') {
            enrichedRejected++;
            continue;
          }
          enriched.push(fallbackCandidate);
        } else {
          const postResearchQuality = scoreLead(validation.data, region);
          const enrichedWithType: EnrichedLead = {
            ...validation.data,
            inferredSupplierType: postResearchQuality.inferredSupplierType,
          };

          await db.collection('leads').updateOne(
            { companyName: lead.company, region },
            {
              $set: {
                status: postResearchQuality.decision === 'reject' ? 'research_rejected' : 'research_enriched',
                segment: mapToCrmSegment(postResearchQuality.inferredSupplierType),
                website: validation.data.website,
                updatedAt: new Date(),
                'metadata.postResearchQuality': postResearchQuality,
                'metadata.supplierType': postResearchQuality.inferredSupplierType,
                'metadata.directToHoreca': validation.data.directToHoreca,
                'metadata.brandsOrPortfolio': validation.data.brandsOrPortfolio,
                'metadata.servesRegions': validation.data.servesRegions,
                'metadata.enrichmentPreview': {
                  website: validation.data.website,
                  companyName: validation.data.companyName,
                  personalizationHook: validation.data.personalizationHook,
                  rawAnalysisPreview: validation.data.rawAnalysis.slice(0, 500),
                },
              },
            },
          );

          console.log(
            `[producer-hunt:${taskId}] post-research quality ${lead.company}: type=${postResearchQuality.inferredSupplierType}, decision=${postResearchQuality.decision}, score=${postResearchQuality.score}, reasons=${postResearchQuality.reasons.join('; ')}`,
          );

          if (postResearchQuality.decision === 'reject') {
            console.warn(`[producer-hunt:${taskId}] post-research reject ${lead.company}`);
            enrichedRejected++;
            continue;
          }
          enriched.push(enrichedWithType);
        }
      } catch (err) {
        console.warn(`[producer-hunt:${taskId}] enrichment fail dla ${lead.company}:`, (err as Error).message);
        const fallbackCandidate: EnrichedLead = {
          ...lead,
          personalizationHook: lead.reason ?? defaultHookForType(declaredOrInferredType, region),
          rawAnalysis: 'Enrichment niedostępny.',
          companyName: lead.company,
        };
        const fallbackQuality = scoreLead(fallbackCandidate, region);
        fallbackCandidate.inferredSupplierType = fallbackQuality.inferredSupplierType;
        if (fallbackQuality.decision === 'reject') {
          enrichedRejected++;
          continue;
        }
        enriched.push(fallbackCandidate);
      }
    }
    return {
      taskId,
      region,
      enriched,
      researchOnlyCount: context.inputData.researchOnlyCount,
      postResearchSummary: {
        inputCandidates: validLeads.length,
        enrichedAccepted: enriched.length,
        enrichedRejected,
      },
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
    postResearchSummary: postResearchSummarySchema.optional(),
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
        const res = await producerHuntEmailExtractionAgent.generate(prompt);
        const candidate = res.text.trim().replace(/^"|"$/g, '');
        if (isValidEmail(candidate)) {
          console.log(`[producer-hunt:${taskId}] znaleziono email dla ${lead.company}: ${candidate}`);
          out.push({ ...lead, email: candidate });
        } else {
          console.warn(`[producer-hunt:${taskId}] local email extraction returned no email for ${lead.company}, próbuję cloud fallback.`);
          try {
            const cloudRes = await producerHuntCloudFallbackAgent.generate(`${prompt}\n\nReturn only one email address or null.`);
            const cloudCandidate = cloudRes.text.trim().replace(/^"|"$/g, '');
            if (isValidEmail(cloudCandidate)) {
              console.log(`[producer-hunt:${taskId}] cloud fallback znalazł email dla ${lead.company}: ${cloudCandidate}`);
              out.push({ ...lead, email: cloudCandidate });
            } else {
              // Nie usuwamy leada! Idzie dalej, ale bez maila nie powstanie draft.
              console.warn(`[producer-hunt:${taskId}] brak emaila dla ${lead.company} — zapiszę w CRM jako do researchu.`);
              out.push(lead);
            }
          } catch (cloudErr) {
            console.warn(
              `[producer-hunt:${taskId}] extract-email cloud fallback fail ${lead.company}:`,
              (cloudErr as Error).message,
            );
            out.push(lead);
          }
        }
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] extract-email fail ${lead.company}:`,
          (err as Error).message,
        );
        try {
          const prompt = `Wyciągnij adres e-mail dla firmy "${lead.company}" z poniższego kontekstu.
Zwróć WYŁĄCZNIE adres email lub słowo "null".
Kontekst: ${lead.rawAnalysis}\nStrona: ${lead.website ?? '-'}`;
          const cloudRes = await producerHuntCloudFallbackAgent.generate(`${prompt}\n\nReturn only one email address or null.`);
          const cloudCandidate = cloudRes.text.trim().replace(/^"|"$/g, '');
          if (isValidEmail(cloudCandidate)) {
            console.log(`[producer-hunt:${taskId}] cloud fallback znalazł email dla ${lead.company}: ${cloudCandidate}`);
            out.push({ ...lead, email: cloudCandidate });
          } else {
            out.push(lead);
          }
        } catch (cloudErr) {
          console.warn(
            `[producer-hunt:${taskId}] extract-email cloud fallback fail ${lead.company}:`,
            (cloudErr as Error).message,
          );
          out.push(lead);
        }
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

      const fallbackDraft = () => ({
        subject: `Współpraca GastroBridge x ${lead.company}`,
        body: `Dzień dobry,\n\nKontaktuję się w sprawie potencjalnej współpracy z Państwa firmą. Buduję GastroBridge – platformę, która pomaga lokalnym producentom z regionu ${region} docierać bezpośrednio do restauracji, z pominięciem zbędnych pośredników.\n\nChętnie sprawdzę, czy nasz model współpracy (obecnie w darmowym pilotażu) mógłby pasować do Państwa asortymentu.\n\nCzy możemy umówić krótką rozmowę?\n\nPozdrawiam,\nPatryk (GastroBridge)\n\n---\nAdministratorem danych jest GastroBridge. Cel: Nawiązanie relacji B2B. Źródło: Publiczne dane z sieci (research). Odpisz "NIE", aby usunąć dane.`
      });

      const prompt = `Jesteś Patrykiem, chefem który koduje i buduje GastroBridge. 
Napisz krótki, profesjonalny cold-email do producenta: "${lead.company}".

KONTEKST O FIRMIE (Deep Research):
${lead.rawAnalysis}

DEDYKOWANY HOOK:
${lead.personalizationHook}

ZASADY PATRYKA:
1. Treść do 180 słów. Konkret, zero "waty" sprzedażowej.
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
        const parsed = await generateJsonWithFallback({
          taskId,
          stepId: 'draft-cold-emails',
          entityName: lead.company,
          prompt,
          schema: draftResponseSchema,
          localAgent: producerHuntDraftAgent,
          repairAgent: producerHuntJsonRepairAgent,
          cloudFallbackAgent: producerHuntCloudFallbackAgent,
          repairPrompt: (badOutput, error) => {
            const validation = validateDraft(tryParseJson(badOutput) as any || { subject: '', body: '' }, lead);
            const failureList = validation.hardFailures.join(', ');
            return `Napraw poniższy draft maila. Musi być poprawnym JSONem i spełniać wszystkie zasady (zwłaszcza RODO i brak placeholderów).
              Błędy: ${failureList || error}
              Oryginalny output: ${badOutput}`;
          },
          fallback: fallbackDraft,
        });

        // Final quality check
        const validation = validateDraft(parsed, lead);
        if (!validation.ok) {
           console.error(`[producer-hunt:${taskId}] draft validation failed for ${lead.company} even after repair/fallback:`, validation.hardFailures.join(', '));
           const safeDraft = fallbackDraft();
           parsed.subject = safeDraft.subject;
           parsed.body = safeDraft.body;
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
        const enrichmentType = draft.enrichment?.inferredSupplierType
          ?? draft.enrichment?.supplierType
          ?? 'producer';
        const segment = mapToCrmSegment(enrichmentType as SupplierType);
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
            segment,
            supplierType: enrichmentType,
            enrichment: draft.enrichment,
            gmailDraftId: draft.gmailDraftId,
            createdAt: new Date().toISOString(),
            agentId: 'producer-hunt-draft-agent',
            llm: { provider: 'mastra', model: workflowModels.producerHunt.draftEmail, costUsd: 0 },
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
      const enrichmentType = draft.enrichment?.inferredSupplierType
        ?? draft.enrichment?.supplierType
        ?? 'producer';
      const segment = mapToCrmSegment(enrichmentType as SupplierType);

      await db.collection('leads').updateOne(
        { email: draft.email },
        {
          $set: {
            email: draft.email,
            companyName: draft.company,
            segment,
            region,
            status: 'draft_gotowy',
            website: draft.enrichment?.website,
            updatedAt: now,
            metadata: {
              enrichment: draft.enrichment,
              supplierType: enrichmentType,
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
    supplierTypes: z.array(supplierTypeSchema).optional(),
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
