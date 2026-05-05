import { createWorkflow, createStep } from '@mastra/core/workflows';
import { marketingAgent } from '../agents/marketing-agent';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { format, addDays, isValid, parseISO, startOfWeek } from 'date-fns';
import { knowledgeQueryTool } from '../tools/knowledge/knowledge-tools.js';
import { calendarCreateEventTool } from '../tools/google/google-tools.js';
import { getDraftsStore } from '../lib/drafts-store.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Schemas ─────────────────────────────────────────────────────────────────
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
      newsHooks: z.array(z.object({ topic: z.string(), hook: z.string(), data: z.string(), source: z.string(), bestFor: z.string() })),
      competitorMoves: z.array(z.object({ competitor: z.string(), move: z.string(), ourAngle: z.string() })),
      sourceCitations: z.array(z.string()).optional(),
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

    let marketAnswer = 'Brak danych z NotebookLM - wygeneruj hooks na podstawie ogólnej wiedzy o polskim rynku HoReCa.';
    let marketCitations: string[] = [];
    let compAnswer = 'Brak danych o konkurencji z NotebookLM.';
    let compCitations: string[] = [];

    try {
      const marketResult = await knowledgeQueryTool.execute!({
        notebook: 'rynek',
        question: `Jakie są 3 najważniejsze newsy z polskiej branży HoReCa lub rolnictwa w tygodniu ${weekDate}? Skup się na cenach, regulacjach, RHD, lokalnych producentach.`,
      }, {} as any);
      if (marketResult && 'success' in marketResult && marketResult.success) {
        marketAnswer = (marketResult as any).answer ?? marketAnswer;
        marketCitations = (marketResult as any).citations ?? [];
      }
    } catch (err) {
      console.warn(`[weekly-content:${taskId}] market NotebookLM fail:`, (err as Error).message);
    }
    
    try {
      const compResult = await knowledgeQueryTool.execute!({
        notebook: 'konkurencja',
        question: 'Co Choco, Proky, Rekki lub inne platformy dostawcze zrobiły w ostatnim tygodniu?',
      }, {} as any);
      if (compResult && 'success' in compResult && compResult.success) {
        compAnswer = (compResult as any).answer ?? compAnswer;
        compCitations = (compResult as any).citations ?? [];
      }
    } catch (err) {
      console.warn(`[weekly-content:${taskId}] competitor NotebookLM fail:`, (err as Error).message);
    }

    // Wczytanie profesjonalnego promptu (jak w Jarvis)
    const promptPath = path.join(__dirname, '..', 'prompts', 'marketing', 'research.md');
    const systemPrompt = await fs.readFile(promptPath, 'utf-8');

    const userPrompt = `
DANE Z NOTEBOOKLM DO ANALIZY:

# PL-Market-Intelligence (Rynek):
${marketAnswer}
Cytaty: ${marketCitations.join('\n') || 'Brak cytatów.'}

# Competitor-Tracking (Konkurencja):
${compAnswer}
Cytaty: ${compCitations.join('\n') || 'Brak cytatów.'}

Tydzień: ${weekDate}

Wybierz 3 najlepsze news hooks i ruchy konkurencji. Zwróć JSON.`;

    const res = await marketingAgent.generate(userPrompt, {
      system: systemPrompt,
      modelSettings: { temperature: 0.5 },
      toolChoice: 'none',
      maxSteps: 1,
    });
    const parsed = tryParseJson<any>(res.text) || {
      newsHooks: [{ topic: 'research-fallback', hook: res.text.slice(0, 200), data: '', source: 'LLM', bestFor: 'linkedin-company' }],
      competitorMoves: [],
      sourceCitations: [...marketCitations, ...compCitations],
    };
    return { taskId, weekDate, liCount, igCount, research: parsed };
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

Zwróć JSON zgodnie ze strukturą opisaną w system prompcie.`;

    const res = await marketingAgent.generate(userPrompt, {
      system: systemPrompt,
      modelSettings: { temperature: 0.4, maxOutputTokens: 8192 },
      toolChoice: 'none',
      maxSteps: 1,
    });
    const parsed = tryParseJson<any>(res.text) || { linkedin: [], instagram: [] };
    return { taskId, weekDate, liPosts: parsed.linkedin ?? [], igPosts: parsed.instagram ?? [] };
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

    const res = await marketingAgent.generate(userPrompt, {
      system: systemPrompt,
      modelSettings: { temperature: 0.5 },
      toolChoice: 'none',
      maxSteps: 1,
    });
    const parsed = tryParseJson<any>(res.text) || { translations: [] };
    return { taskId, weekDate, liPosts, igPosts: context.inputData.igPosts, enPosts: parsed.translations ?? [] };
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
