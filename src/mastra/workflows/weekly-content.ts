import { createWorkflow, createStep } from '@mastra/core/workflows';
import { marketingAgent } from '../agents/marketing-agent';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { format, addDays, isValid, parseISO, startOfWeek } from 'date-fns';
import { knowledgeQueryTool } from '../tools/knowledge/knowledge-tools.js';
import { calendarCreateEventTool, gmailCreateDraftTool } from '../tools/google/google-tools.js';
import { getDraftsStore } from '../lib/drafts-store.js';

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
    return JSON.parse(match ? match[1] : text);
  } catch {
    return null;
  }
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
  }),
  outputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    research: z.object({
      newsHooks: z.array(z.object({ topic: z.string(), hook: z.string(), data: z.string(), source: z.string(), bestFor: z.string() })),
      competitorMoves: z.array(z.object({ competitor: z.string(), move: z.string(), ourAngle: z.string() })),
    }),
  }),
  execute: async (context) => {
    const taskId = `weekly-content-${randomUUID().slice(0, 8)}`;
    const weekDate = resolveWeekStarting(context.inputData.weekDate);
    console.log(`[weekly-content:${taskId}] research-week date=${weekDate}`);

    const marketResult = await knowledgeQueryTool.execute!({
      notebook: 'rynek',
      question: `Jakie są 3 najważniejsze newsy z polskiej branży HoReCa lub rolnictwa w tygodniu ${weekDate}? Skup się na cenach, regulacjach, RHD.`,
    }, {} as any);
    
    const compResult = await knowledgeQueryTool.execute!({
      notebook: 'konkurencja',
      question: 'Co Choco, Proky lub inne platformy dostawcze zrobiły w ostatnim tygodniu?',
    }, {} as any);

    const prompt = `Na podstawie danych z researchu, wybierz 3 najlepsze news hooks i ruchy konkurencji dla GastroBridge.
Tydzień: ${weekDate}

DANE RYNKOWE:
${(marketResult && 'success' in marketResult && marketResult.success) ? (marketResult as any).answer : 'Brak danych rynkowych.'}

KONKURENCJA:
${(compResult && 'success' in compResult && compResult.success) ? (compResult as any).answer : 'Brak danych o konkurencji.'}

Zwróć WYŁĄCZNIE JSON:
{
  "newsHooks": [{ "topic": "...", "hook": "...", "data": "...", "source": "...", "bestFor": "linkedin|instagram" }],
  "competitorMoves": [{ "competitor": "...", "move": "...", "ourAngle": "..." }]
}`;

    const res = await marketingAgent.generate(prompt);
    const parsed = tryParseJson<any>(res.text) || { newsHooks: [], competitorMoves: [] };
    return { taskId, weekDate, research: parsed };
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
    liCount: z.number().default(3),
    igCount: z.number().default(2),
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

    const prompt = `Wygeneruj ${liCount} postów LinkedIn i ${igCount} treści Instagram dla GastroBridge.
Tydzień: ${weekDate}
Research: ${JSON.stringify(research)}

Zwróć WYŁĄCZNIE JSON:
{
  "linkedin": [{ "account": "firmowe|osobiste", "topic": "...", "post": "...", "hashtags": [], "char_count": 0, "rationale": "...", "suggestedDay": "Monday", "suggestedTime": "10:00", "needsImage": true, "imagePrompt": "..." }],
  "instagram": [{ "type": "post|carousel|story", "topic": "...", "caption": "...", "hashtags": [], "char_count": 0, "rationale": "...", "suggestedDay": "Wednesday", "suggestedTime": "12:00", "imagePrompt": "...", "slideCount": 1 }]
}`;

    const res = await marketingAgent.generate(prompt);
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

    console.log(`[weekly-content:${taskId}] translate-en (count:${topPosts.length})`);
    const prompt = `Przetłumacz i zaadaptuj poniższe posty LinkedIn na język angielski (profesjonalny tone):
${JSON.stringify(topPosts)}

Zwróć WYŁĄCZNIE JSON: { "translations": [{ "originalTopic": "...", "post": "...", "hashtags": [], "char_count": 0, "adaptationNotes": "..." }] }`;

    const res = await marketingAgent.generate(prompt);
    const parsed = tryParseJson<any>(res.text);
    return { ...context.inputData, enPosts: parsed?.translations ?? [] };
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
        metadata: { draftId, taskId, type: 'linkedin-post', language: 'pl', topic: p.topic, hashtags: p.hashtags, charCount: p.char_count, scheduledFor: date.toISOString(), weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
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
        metadata: { draftId, taskId, type: 'instagram-post', language: 'pl', topic: p.topic, hashtags: p.hashtags, charCount: p.char_count, scheduledFor: date.toISOString(), weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
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
        metadata: { draftId, taskId, type: 'linkedin-post', language: 'en', topic: p.originalTopic, hashtags: p.hashtags, charCount: p.char_count, weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
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
          summary: `[PUBLIKACJA] ${r.title}`,
          description: `Przypomnienie o publikacji posta dla tygodnia ${r.date}. TaskId: ${taskId}`,
          startTime: r.date,
          endTime: new Date(new Date(r.date).getTime() + 30 * 60 * 1000).toISOString(),
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
    liCount: z.number().default(3).describe('Liczba postów LinkedIn'),
    igCount: z.number().default(2).describe('Liczba postów Instagram'),
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
