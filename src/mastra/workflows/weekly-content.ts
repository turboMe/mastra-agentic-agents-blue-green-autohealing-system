import { createWorkflow, createStep } from '@mastra/core/workflows';
import { marketingAgent } from '../agents/marketing-agent';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { format, addDays, isValid, parseISO, startOfWeek } from 'date-fns';
import { knowledgeQueryMultiTool, knowledgeResearchStartTool } from '../tools/knowledge/knowledge-tools.js';
import { calendarCreateEventTool } from '../tools/google/google-tools.js';
import { getDraftsStore } from '../lib/drafts-store.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Schemas ─────────────────────────────────────────────────────────────────
const newsHookSchema = z.object({
  topic: z.string(),
  hook: z.string(),
  data: z.string(),
  source: z.string(),
  bestFor: z.string(),
});

const competitorMoveSchema = z.object({
  competitor: z.string(),
  move: z.string(),
  ourAngle: z.string(),
});

const contentHistoryItemSchema = z.object({
  topic: z.string(),
  type: z.string(),
  language: z.string(),
  weekStarting: z.string().optional(),
  scheduledFor: z.string().optional(),
  rationale: z.string().optional(),
});

const researchResultSchema = z.object({
  newsHooks: z.array(newsHookSchema),
  competitorMoves: z.array(competitorMoveSchema),
  sourceCitations: z.array(z.string()).optional(),
});

const liPostSchema = z.object({
  account: z.string(),
  topic: z.string(),
  post: z.string(),
  hashtags: z.array(z.string()),
  char_count: z.number(),
  rationale: z.string(),
  suggestedDay: z.string(),
  suggestedTime: z.string(),
  needsImage: z.boolean(),
  imagePrompt: z.string(),
});

const igPostSchema = z.object({
  type: z.string(),
  topic: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
  char_count: z.number(),
  rationale: z.string(),
  suggestedDay: z.string(),
  suggestedTime: z.string(),
  imagePrompt: z.string(),
  slideCount: z.number(),
});

const enPostSchema = z.object({
  originalTopic: z.string(),
  post: z.string(),
  hashtags: z.array(z.string()),
  char_count: z.number(),
  adaptationNotes: z.string(),
});

const copyPlResultSchema = z.object({
  linkedin: z.array(liPostSchema),
  instagram: z.array(igPostSchema),
});

const copyEnResultSchema = z.object({
  translations: z.array(enPostSchema),
});

const tryParseJson = <T = unknown>(text: string): T | null => {
  try {
    const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
    if (match) return JSON.parse(match[1]);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const normalizeCount = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
};

const CORE_RESEARCH_NOTEBOOKS = ['rynek', 'rhd', 'konkurencja', 'founder'] as const;
type ResearchNotebook = typeof CORE_RESEARCH_NOTEBOOKS[number];
type NotebookAnswer = { answer: string; citations: string[]; error?: string };
type ContentHistoryItem = z.infer<typeof contentHistoryItemSchema>;

const NO_SOURCE_NOTE = 'Brak wiarygodnych danych z NotebookLM. Nie wymyślaj nowych faktów ani liczb; jeśli trzeba, wybierz evergreen angle bez danych liczbowych.';
const LOW_SIGNAL_PATTERNS = [
  /brak danych/i,
  /brak .*informacji/i,
  /nie znaleziono/i,
  /nie mam/i,
  /niedostęp/i,
  /no data/i,
  /not found/i,
  /unavailable/i,
  /cannot/i,
  /can't/i,
];

function emptyNotebookAnswer(error?: string): NotebookAnswer {
  return { answer: NO_SOURCE_NOTE, citations: [], error };
}

function normalizeNotebookResults(results: unknown): Record<ResearchNotebook, NotebookAnswer> {
  const rawResults = results && typeof results === 'object' ? results as Record<string, any> : {};
  return Object.fromEntries(CORE_RESEARCH_NOTEBOOKS.map((notebook) => {
    const raw = rawResults[notebook];
    if (!raw || raw.error) {
      return [notebook, emptyNotebookAnswer(raw?.error)];
    }
    return [notebook, {
      answer: typeof raw.answer === 'string' && raw.answer.trim() ? raw.answer : NO_SOURCE_NOTE,
      citations: Array.isArray(raw.citations) ? raw.citations.filter((v: unknown): v is string => typeof v === 'string') : [],
    }];
  })) as Record<ResearchNotebook, NotebookAnswer>;
}

function buildCoreResearchQuestion(weekDate: string): string {
  return `Przygotuj research do tygodniowego contentu GastroBridge dla tygodnia ${weekDate}.

Rozbij odpowiedź na obszary zgodne z notebookiem:
- rynek: najważniejsze aktualne sygnały z polskiej HoReCa, rolnictwa, cen, dostaw i lokalnych producentów.
- rhd: praktyczne wnioski z RHD/PKE/regulacji dla producentów żywności i restauratorów.
- konkurencja: Choco, Proky, Rekki i inne platformy dostawcze; konkretne ruchy, pozycjonowanie, feature'y.
- founder: głos Patryka, historia Head Chefa, doświadczenie kuchni, argumenty bez marketingowej waty.

Podawaj tylko fakty obecne w źródłach notebooka. Jeśli notebook nie ma aktualnych danych, napisz to jawnie zamiast zgadywać. Zachowaj cytowalne źródła.`;
}

function buildFreshResearchQuery(notebook: ResearchNotebook, weekDate: string): string {
  const queries: Record<ResearchNotebook, string> = {
    rynek: `Aktualne wydarzenia z tygodnia ${weekDate} na polskim rynku HoReCa, lokalni producenci żywności, ceny, dostawy, restauracje, marketplace B2B.`,
    rhd: `Aktualne informacje z tygodnia ${weekDate} o RHD, PKE, lokalnych producentach żywności i sprzedaży do gastronomii w Polsce.`,
    konkurencja: `Aktualne ruchy konkurencji z tygodnia ${weekDate}: Choco, Proky, Rekki, platformy zakupowe dla HoReCa i dostawców żywności.`,
    founder: `Kontekst founder voice GastroBridge: Patryk jako były Head Chef, doświadczenia kuchni, ton komunikacji dla HoReCa.`,
  };
  return queries[notebook];
}

function isWeakFreshnessSignal(result: NotebookAnswer): boolean {
  const answer = result.answer.trim();
  if (!answer || answer === NO_SOURCE_NOTE || answer.length < 220) return true;
  if (result.citations.length < 2) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(answer));
}

function getWeakFreshResearchNotebooks(results: Record<ResearchNotebook, NotebookAnswer>): ResearchNotebook[] {
  return (['rynek', 'rhd', 'konkurencja'] as ResearchNotebook[])
    .filter((notebook) => isWeakFreshnessSignal(results[notebook]));
}

function resolveFreshResearchMode(): 'fast' | 'deep' {
  return process.env.WEEKLY_CONTENT_FRESH_RESEARCH_MODE === 'deep' ? 'deep' : 'fast';
}

async function queryCoreNotebooks(taskId: string, weekDate: string): Promise<Record<ResearchNotebook, NotebookAnswer>> {
  try {
    const result = await knowledgeQueryMultiTool.execute!({
      notebooks: [...CORE_RESEARCH_NOTEBOOKS],
      question: buildCoreResearchQuestion(weekDate),
    }, {} as any);
    if (result && 'success' in result && result.success) {
      return normalizeNotebookResults((result as any).results);
    }
    console.warn(`[weekly-content:${taskId}] knowledge.query_multi returned no usable results`);
  } catch (err) {
    console.warn(`[weekly-content:${taskId}] knowledge.query_multi fail:`, (err as Error).message);
  }
  return normalizeNotebookResults({});
}

async function refreshWeakNotebookSources(
  taskId: string,
  weekDate: string,
  notebookResults: Record<ResearchNotebook, NotebookAnswer>,
): Promise<string[]> {
  const configuredMaxResearchStarts = Number(process.env.WEEKLY_CONTENT_MAX_FRESH_RESEARCH ?? 2);
  const maxResearchStarts = Number.isFinite(configuredMaxResearchStarts) ? Math.max(0, configuredMaxResearchStarts) : 2;
  const weakNotebooks = getWeakFreshResearchNotebooks(notebookResults).slice(0, maxResearchStarts);
  const notes: string[] = [];
  if (weakNotebooks.length === 0) return notes;

  for (const notebook of weakNotebooks) {
    try {
      const result = await knowledgeResearchStartTool.execute!({
        query: buildFreshResearchQuery(notebook, weekDate),
        notebookId: notebook,
        mode: resolveFreshResearchMode(),
        autoImport: true,
      }, {} as any);
      if (result && 'success' in result && result.success) {
        notes.push(`knowledge.research_start:${notebook}:${(result as any).taskId || 'started'}`);
      } else {
        notes.push(`knowledge.research_start:${notebook}:failed:${(result as any)?.error ?? 'unknown error'}`);
      }
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[weekly-content:${taskId}] research_start ${notebook} fail:`, message);
      notes.push(`knowledge.research_start:${notebook}:failed:${message}`);
    }
  }
  return notes;
}

function formatNotebookSection(title: string, result: NotebookAnswer): string {
  return `${title}:
${result.answer}
Cytaty: ${result.citations.join('\n') || 'Brak cytatów.'}${result.error ? `\nBłąd: ${result.error}` : ''}`;
}

function formatContentHistory(history: ContentHistoryItem[]): string {
  if (history.length === 0) {
    return 'Brak ostatnich draftów w historii. Nadal unikaj generycznych tematów i pilnuj unikalności angle.';
  }
  return history
    .map((item, index) => `${index + 1}. ${item.topic} | ${item.type} | ${item.language}${item.weekStarting ? ` | tydz. ${item.weekStarting}` : ''}${item.rationale ? ` | angle: ${item.rationale}` : ''}`)
    .join('\n');
}

async function loadRecentContentHistory(limit: number = 24): Promise<ContentHistoryItem[]> {
  const store = getDraftsStore();
  const metadata = await store.listRecentMetadata(limit * 3);
  const seen = new Set<string>();
  const result: ContentHistoryItem[] = [];

  for (const item of metadata) {
    if (item.agentId !== 'marketing-agent') continue;
    if (!['linkedin-post', 'instagram-caption'].includes(item.type)) continue;
    if (!item.topic) continue;

    const key = `${item.type}:${item.language}:${item.topic.toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      topic: item.topic,
      type: item.type,
      language: item.language,
      weekStarting: item.weekStarting,
      scheduledFor: item.scheduledFor,
      rationale: item.rationale,
    });
    if (result.length >= limit) break;
  }

  return result;
}

function collectCitations(
  notebookResults: Record<ResearchNotebook, NotebookAnswer>,
  freshnessNotes: string[],
): string[] {
  return Array.from(new Set([
    ...CORE_RESEARCH_NOTEBOOKS.flatMap((notebook) => notebookResults[notebook].citations),
    ...freshnessNotes,
  ].filter(Boolean)));
}

async function generateJsonWithRepair<T extends {}>({
  taskId,
  stepId,
  userPrompt,
  systemPrompt,
  schema,
  modelSettings,
}: {
  taskId: string;
  stepId: string;
  userPrompt: string;
  systemPrompt: string;
  schema: z.ZodType<T, T>;
  modelSettings?: { temperature?: number; maxOutputTokens?: number };
}): Promise<T> {
  const res = await marketingAgent.generate(userPrompt, {
    system: systemPrompt,
    modelSettings,
    toolChoice: 'none',
    maxSteps: 1,
  });
  const parsed = tryParseJson<T>(res.text);
  const validated = schema.safeParse(parsed);
  if (validated.success) return validated.data;

  console.warn(`[weekly-content:${taskId}] ${stepId} invalid JSON, attempting structured repair`);
  const repairPrompt = `Napraw poniższą odpowiedź modelu do poprawnego obiektu JSON zgodnego ze schematem kroku "${stepId}".
Zwróć tylko dane, bez komentarza i bez markdown.

ORYGINALNA ODPOWIEDŹ:
${res.text}`;

  const repaired = await marketingAgent.generate<T>(repairPrompt, {
    system: 'Jesteś deterministycznym parserem JSON. Zachowaj sens danych wejściowych, usuń tekst poza JSON i nie dopowiadaj faktów.',
    structuredOutput: {
      schema,
      jsonPromptInjection: true,
      instructions: 'Return only the validated structured object required by the schema.',
    },
    modelSettings: { temperature: 0 },
    toolChoice: 'none',
    maxSteps: 1,
  });

  if (!repaired.object) {
    throw new Error(`[weekly-content:${taskId}] ${stepId} structured repair returned no object`);
  }
  return repaired.object;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveWeekStarting(date?: string): string {
  if (!date) {
    return format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');
  }
  const parsed = parseISO(date);
  if (!isValid(parsed)) return format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');
  return format(parsed, 'yyyy-MM-dd');
}

function getPublishingDate(weekStarting: string, suggestedDay: string, suggestedTime: string): Date {
  const dayOffsets: Record<string, number> = {
    monday: 0, poniedzialek: 0, tuesday: 1, wtorek: 1, wednesday: 2, sroda: 2,
    thursday: 3, czwartek: 3, friday: 4, piatek: 4, saturday: 5, sobota: 5, sunday: 6, niedziela: 6
  };
  const normalizedDay = suggestedDay.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\|.*$/, '').trim();
  const date = addDays(parseISO(`${weekStarting}T00:00:00`), dayOffsets[normalizedDay] ?? 0);
  const timeMatch = (suggestedTime ?? '10:00').match(/^(\d{1,2}):(\d{2})/);
  date.setHours(Math.min(Number(timeMatch?.[1] ?? 10), 23), Math.min(Number(timeMatch?.[2] ?? 0), 59), 0, 0);
  return date;
}

// ── Step 01: research-week ──────────────────────────────────────────────────
const researchWeekStep = createStep({
  id: 'research-week',
  description: 'Zbiera newsy i ruchy konkurencji z NotebookLM.',
  inputSchema: z.object({
    weekDate: z.string().optional(),
    liCount: z.number().default(5),
    igCount: z.number().default(3),
    linkedinCount: z.number().optional(),
    instagramCount: z.number().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    liCount: z.number(),
    igCount: z.number(),
    research: z.object({
      newsHooks: z.array(newsHookSchema),
      competitorMoves: z.array(competitorMoveSchema),
      sourceCitations: z.array(z.string()).optional(),
      recentContentTopics: z.array(contentHistoryItemSchema).optional(),
      researchDiagnostics: z.array(z.string()).optional(),
    }),
  }),
  execute: async (context) => {
    const taskId = `weekly-content-${randomUUID().slice(0, 8)}`;
    const weekDate = resolveWeekStarting(context.inputData.weekDate);
    const initData = context.getInitData<{
      liCount?: number;
      igCount?: number;
      linkedinCount?: number;
      instagramCount?: number;
    }>();
    const liCount = normalizeCount(initData.linkedinCount ?? initData.liCount ?? context.inputData.liCount, 5);
    const igCount = normalizeCount(initData.instagramCount ?? initData.igCount ?? context.inputData.igCount, 3);
    console.log(`[weekly-content:${taskId}] research-week date=${weekDate}`);

    const recentContentTopics = await loadRecentContentHistory();
    let notebookResults = await queryCoreNotebooks(taskId, weekDate);
    const freshnessNotes = await refreshWeakNotebookSources(taskId, weekDate, notebookResults);
    if (freshnessNotes.some((note) => !note.includes(':failed:'))) {
      notebookResults = await queryCoreNotebooks(taskId, weekDate);
    }
    const sourceCitations = collectCitations(notebookResults, freshnessNotes);

    // Wczytanie profesjonalnego promptu (jak w Jarvis)
    const promptPath = path.join(__dirname, '..', 'prompts', 'marketing', 'research.md');
    const systemPrompt = await fs.readFile(promptPath, 'utf-8');

    const userPrompt = `
DANE Z NOTEBOOKLM DO ANALIZY:

# PL-Market-Intelligence (Rynek)
${formatNotebookSection('Rynek', notebookResults.rynek)}

# RHD / regulacje / producenci
${formatNotebookSection('RHD', notebookResults.rhd)}

# Competitor-Tracking (Konkurencja)
${formatNotebookSection('Konkurencja', notebookResults.konkurencja)}

# Founder Voice (Patryk)
${formatNotebookSection('Founder', notebookResults.founder)}

# Historia ostatniego contentu - unikaj powtarzania tematów i angle
${formatContentHistory(recentContentTopics)}

# Diagnostyka świeżości źródeł
${freshnessNotes.join('\n') || 'Nie uruchamiano knowledge.research_start, bo query_multi zwróciło wystarczający sygnał.'}

Tydzień: ${weekDate}

Wybierz 3 najlepsze news hooks i ruchy konkurencji. Jeśli brakuje danych źródłowych, nie zgaduj liczb ani newsów: użyj ostrożnego evergreen angle i ustaw puste "data". Zwróć JSON.`;

    const research = await generateJsonWithRepair({
      taskId,
      stepId: 'research-week',
      userPrompt,
      systemPrompt,
      schema: researchResultSchema,
      modelSettings: { temperature: 0.5 },
    });
    if (research.newsHooks.length === 0) {
      research.newsHooks.push({
        topic: 'research-fallback',
        hook: 'Brak wystarczających danych źródłowych z NotebookLM. Przygotuj ostrożny angle edukacyjny bez nowych liczb.',
        data: '',
        source: 'LLM fallback',
        bestFor: 'linkedin-company',
      });
    }
    research.sourceCitations = Array.from(new Set([...(research.sourceCitations ?? []), ...sourceCitations]));
    return {
      taskId,
      weekDate,
      liCount,
      igCount,
      research: {
        newsHooks: research.newsHooks,
        competitorMoves: research.competitorMoves,
        sourceCitations: research.sourceCitations,
        recentContentTopics,
        researchDiagnostics: freshnessNotes,
      },
    };
  },
});

// ── Step 02: generate-pl ────────────────────────────────────────────────────
const generatePlStep = createStep({
  id: 'generate-pl',
  description: 'Generuje posty LinkedIn i Instagram w języku polskim.',
  inputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    research: z.any(),
    liCount: z.number().default(5),
    igCount: z.number().default(3),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    liPosts: z.array(liPostSchema),
    igPosts: z.array(igPostSchema),
  }),
  execute: async (context) => {
    const { taskId, weekDate, research, liCount, igCount } = context.inputData;
    console.log(`[weekly-content:${taskId}] generate-pl (LI:${liCount}, IG:${igCount})`);

    // Wczytanie profesjonalnego promptu copy (PL)
    const promptPath = path.join(__dirname, '..', 'prompts', 'marketing', 'copy-pl.md');
    const systemPrompt = await fs.readFile(promptPath, 'utf-8');

    const userPrompt = `Wygeneruj ${liCount} postów LinkedIn i ${igCount} treści Instagram dla GastroBridge.
Tydzień: ${weekDate}
RESEARCH DATA (użyj tych faktów i liczb):
${JSON.stringify(research, null, 2)}

Ważne:
- LinkedIn ma być mixem konta osobistego Patryka i konta firmowego GastroBridge.
- Instagram ma rotować formaty: post, karuzela, story lub reel.
- Rotuj angle: data insight, story from kitchen, building in public, customer spotlight.
- LinkedIn osobiste preferuj wtorek/czwartek 10:00.
- LinkedIn firmowe preferuj poniedziałek/środa/piątek 10:00.
- Instagram feed preferuj 12:00-13:00 albo 18:00-20:00.
- Każdy post MUSI mieć unikalny temat.
- Nie powtarzaj tematów ani angle z research.recentContentTopics.

Zwróć JSON zgodnie ze strukturą opisaną w system prompcie.`;

    const parsed = await generateJsonWithRepair({
      taskId,
      stepId: 'generate-pl',
      userPrompt,
      systemPrompt,
      schema: copyPlResultSchema,
      modelSettings: { temperature: 0.4, maxOutputTokens: 8192 },
    });
    if (parsed.linkedin.length === 0 && parsed.instagram.length === 0) {
      throw new Error(`[weekly-content:${taskId}] generate-pl returned zero drafts after JSON repair`);
    }
    return { taskId, weekDate, liPosts: parsed.linkedin, igPosts: parsed.instagram };
  },
});

// ── Step 03: translate-en ───────────────────────────────────────────────────
const translateEnStep = createStep({
  id: 'translate-en',
  description: 'Tłumaczy wybrane posty LinkedIn na język angielski.',
  inputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    liPosts: z.array(liPostSchema),
    igPosts: z.array(igPostSchema),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    liPosts: z.array(liPostSchema),
    igPosts: z.array(igPostSchema),
    enPosts: z.array(enPostSchema),
  }),
  execute: async (context) => {
    const { taskId, weekDate, liPosts } = context.inputData;
    const topPosts = liPosts.slice(0, 2);
    if (topPosts.length === 0) return { ...context.inputData, enPosts: [] };

    // Wczytanie profesjonalnego promptu adaptacji (EN)
    const promptPath = path.join(__dirname, '..', 'prompts', 'marketing', 'copy-en.md');
    const systemPrompt = await fs.readFile(promptPath, 'utf-8');

    const userPrompt = `Translate and adapt these Polish LinkedIn posts to English:
${topPosts.map((p, i) => `### Post ${i + 1}: ${p.topic}\n${p.post}\nHashtags: ${p.hashtags.join(' ')}`).join('\n\n---\n\n')}

Zwróć JSON zgodnie ze strukturą opisaną w system prompcie.`;

    const parsed = await generateJsonWithRepair({
      taskId,
      stepId: 'translate-en',
      userPrompt,
      systemPrompt,
      schema: copyEnResultSchema,
      modelSettings: { temperature: 0.5 },
    });
    return { taskId, weekDate, liPosts, igPosts: context.inputData.igPosts, enPosts: parsed.translations };
  },
});

// ── Step 04: save-drafts ────────────────────────────────────────────────────
const saveDraftsStep = createStep({
  id: 'save-drafts',
  description: 'Zapisuje wszystkie drafty do Filesystemu i Gmaila.',
  inputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    liPosts: z.array(liPostSchema),
    igPosts: z.array(igPostSchema),
    enPosts: z.array(enPostSchema),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    draftCount: z.number(),
    calendarReminders: z.array(z.object({ title: z.string(), date: z.string() })),
  }),
  execute: async (context) => {
    const { taskId, weekDate, liPosts, igPosts, enPosts } = context.inputData;
    const store = getDraftsStore();
    await store.ensureBaseDir();
    let count = 0;
    const reminders: Array<{ title: string; date: string }> = [];

    // LI PL
    for (const p of liPosts) {
      const draftId = `li-pl-${randomUUID().slice(0, 6)}`;
      const date = getPublishingDate(weekDate, p.suggestedDay, p.suggestedTime);
      await store.save({
        taskId, draftId,
        content: `# ${p.topic}\n\n${p.post}\n\n---\n${p.hashtags.join(' ')}`,
        metadata: { draftId, taskId, type: 'linkedin-post', language: 'pl', topic: p.topic, hashtags: p.hashtags, charCount: p.char_count, rationale: p.rationale, imagePrompt: p.imagePrompt, scheduledFor: date.toISOString(), weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
      });
      reminders.push({ title: `LinkedIn: ${p.topic}`, date: date.toISOString() });
      count++;
    }

    // IG PL
    for (const p of igPosts) {
      const draftId = `ig-pl-${randomUUID().slice(0, 6)}`;
      const date = getPublishingDate(weekDate, p.suggestedDay, p.suggestedTime);
      await store.save({
        taskId, draftId,
        content: `# ${p.topic} (${p.type})\n\n${p.caption}\n\n---\n${p.hashtags.join(' ')}`,
        metadata: { draftId, taskId, type: 'instagram-caption', language: 'pl', topic: p.topic, hashtags: p.hashtags, charCount: p.char_count, rationale: p.rationale, imagePrompt: p.imagePrompt, scheduledFor: date.toISOString(), weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
      });
      reminders.push({ title: `Instagram: ${p.topic}`, date: date.toISOString() });
      count++;
    }

    // EN LI
    for (const p of enPosts) {
      const draftId = `li-en-${randomUUID().slice(0, 6)}`;
      await store.save({
        taskId, draftId,
        content: `# ${p.originalTopic} (EN)\n\n${p.post}\n\n---\n${p.hashtags.join(' ')}`,
        metadata: { draftId, taskId, type: 'linkedin-post', language: 'en', topic: p.originalTopic, hashtags: p.hashtags, charCount: p.char_count, rationale: p.adaptationNotes, weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
      });
      count++;
    }

    return { taskId, draftCount: count, calendarReminders: reminders };
  },
});

// ── Step 05: create-reminders ───────────────────────────────────────────────
const createRemindersStep = createStep({
  id: 'create-reminders',
  description: 'Tworzy wydarzenia w Google Calendar.',
  inputSchema: z.object({
    taskId: z.string(),
    calendarReminders: z.array(z.object({ title: z.string(), date: z.string() })),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    remindersCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, calendarReminders } = context.inputData;
    let count = 0;
    for (const r of calendarReminders) {
      try {
        await calendarCreateEventTool.execute!({
          title: `[PUBLIKACJA] ${r.title}`,
          description: `Przypomnienie o publikacji posta dla tygodnia ${r.date}. TaskId: ${taskId}`,
          scheduledFor: r.date,
        }, {} as any);
        count++;
      } catch (err) {
        console.warn(`[weekly-content:${taskId}] calendar fail:`, (err as Error).message);
      }
    }
    return { taskId, remindersCount: count };
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────
export const weeklyContentWorkflow = createWorkflow({
  id: 'weekly-content',
  description: 'Generuje cotygodniowy content (LI, IG) w PL i EN + Calendar reminders.',
  inputSchema: z.object({
    weekDate: z.string().optional().describe('Data poniedziałku (YYYY-MM-DD). Domyślnie obecny tydzień.'),
    liCount: z.number().default(5).describe('Liczba postów LinkedIn'),
    igCount: z.number().default(3).describe('Liczba postów Instagram'),
    linkedinCount: z.number().optional().describe('Legacy alias liczby postów LinkedIn'),
    instagramCount: z.number().optional().describe('Legacy alias liczby postów Instagram'),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    draftCount: z.number(),
    remindersCount: z.number(),
  })
})
  .then(researchWeekStep)
  .then(generatePlStep)
  .then(translateEnStep)
  .then(saveDraftsStep)
  .then(createRemindersStep);

weeklyContentWorkflow.commit();
