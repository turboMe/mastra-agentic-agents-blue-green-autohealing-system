/**
 * Passive pre-context builder for coding harness calls.
 *
 * The builder is intentionally defensive: every source is best-effort and
 * dependency failures produce a suppressed reason instead of blocking the LLM
 * call. Dynamic context is returned as markdown for user-prompt injection.
 */

import { getDb } from '../lib/mongo.js';
import { recallKnowledge, type RecallResult } from '../lib/failure-brain.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getSkillRegistry, type SkillSearchResult } from './skill-registry.js';
import { assembleContext } from './context-assembler.js';
import { tokenEstimate } from './harness-events.js';

export type CodingPrecontextInput = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  userPrompt: string;
  repoPath?: string;
  targetFiles?: string[];
  maxTokens?: number;
  includeMemory?: boolean;
  includeSkills?: boolean;
  includeRepoMap?: boolean;
  includeCheckpoint?: boolean;
};

export type CodingPrecontextResult = {
  markdown: string;
  tokenEstimate: number;
  memoryCount: number;
  skillCount: number;
  repoMapIncluded: boolean;
  checkpointIncluded: boolean;
  suppressedReasons: string[];
};

type PendingMemoryContext = {
  id?: string;
  _id?: unknown;
  threadId?: string;
  taskId?: string;
  agentId?: string;
  prompt?: string;
  displayPrompt?: string;
  memoryIds?: string[];
  count?: number;
  tokenEstimate?: number;
};

const DEFAULT_MAX_TOKENS = 2048;

export async function buildCodingPrecontext(
  input: CodingPrecontextInput,
): Promise<CodingPrecontextResult> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const includeMemory = input.includeMemory ?? true;
  const includeSkills = input.includeSkills ?? true;
  const includeRepoMap = input.includeRepoMap ?? true;
  const includeCheckpoint = input.includeCheckpoint ?? true;
  const suppressedReasons: string[] = [];
  const sections: string[] = [];

  let memoryCount = 0;
  let skillCount = 0;
  let repoMapIncluded = false;
  let checkpointIncluded = false;

  if (includeMemory) {
    const pending = isHarnessFeatureEnabled('FEATURE_ASYNC_SEMANTIC_MEMORY', false)
      ? await tryPendingMemory(input, suppressedReasons)
      : null;

    if (pending?.markdown) {
      sections.push('### Relevant Memory');
      sections.push(pending.markdown);
      sections.push('');
      memoryCount = pending.count;
    } else {
      const recalled = await tryRecallMemory(input.userPrompt, suppressedReasons);
      if (recalled.length > 0) {
        sections.push('### Relevant Memory');
        sections.push(formatMemoryItems(recalled, 520));
        sections.push('');
        memoryCount = recalled.length;
      }
    }
  }

  if (includeSkills) {
    const skills = await trySkillSearch(input.userPrompt, suppressedReasons);
    if (skills.length > 0) {
      sections.push('### Relevant Skills');
      sections.push(formatSkillItems(skills));
      sections.push('');
      skillCount = skills.length;
    }
  }

  if ((includeRepoMap || includeCheckpoint) && !input.repoPath) {
    suppressedReasons.push('repoPath_missing');
  }

  if (input.repoPath && (includeRepoMap || includeCheckpoint)) {
    const assembled = await tryAssembleContext(input, maxTokens, suppressedReasons);
    if (assembled.repoMap && assembled.repoMap.length > 20) {
      sections.push('### Repository Map');
      sections.push('```');
      sections.push(truncateToTokens(assembled.repoMap, Math.min(1100, Math.floor(maxTokens * 0.55))));
      sections.push('```');
      sections.push('');
      repoMapIncluded = true;
    }
    if (assembled.checkpoint && assembled.checkpoint.length > 10) {
      sections.push('### Current Checkpoint');
      sections.push(truncateToTokens(assembled.checkpoint, Math.min(550, Math.floor(maxTokens * 0.30))));
      sections.push('');
      checkpointIncluded = true;
    }
  }

  if (sections.length === 0) {
    return {
      markdown: '',
      tokenEstimate: 0,
      memoryCount,
      skillCount,
      repoMapIncluded,
      checkpointIncluded,
      suppressedReasons,
    };
  }

  const body = truncateToTokens(sections.join('\n'), Math.max(1, maxTokens - 40));
  const markdown = [
    '## Passive Context',
    '',
    body,
    'Use this context only if it is relevant. Prefer current file contents over stale memory.',
  ].join('\n');

  return {
    markdown,
    tokenEstimate: tokenEstimate(markdown),
    memoryCount,
    skillCount,
    repoMapIncluded,
    checkpointIncluded,
    suppressedReasons,
  };
}

async function tryPendingMemory(
  input: CodingPrecontextInput,
  suppressedReasons: string[],
): Promise<{ markdown: string; count: number } | null> {
  if (!input.threadId && !input.taskId) return null;

  try {
    const db = await getDb();
    const identityClauses = [
      ...(input.threadId ? [{ threadId: input.threadId }] : []),
      ...(input.taskId ? [{ taskId: input.taskId }] : []),
    ];
    const query: Record<string, unknown> = {
      status: 'pending',
      expiresAt: { $gt: new Date() },
      $or: identityClauses,
    };
    if (input.agentId) query.agentId = input.agentId;

    const doc = await db
      .collection<PendingMemoryContext>('pending_memory_context')
      .find(query)
      .sort({ computedAt: -1 })
      .limit(1)
      .next();

    const markdown = (doc?.displayPrompt ?? doc?.prompt ?? '').trim();
    if (!doc || !markdown) return null;

    await db.collection('pending_memory_context').updateOne(
      { _id: doc._id },
      { $set: { status: 'consumed', consumedAt: new Date() } },
    ).catch(() => undefined);

    return { markdown, count: doc.count ?? doc.memoryIds?.length ?? 0 };
  } catch (error) {
    suppressedReasons.push(`pending_memory_unavailable:${(error as Error).message}`);
    return null;
  }
}

async function tryRecallMemory(
  query: string,
  suppressedReasons: string[],
): Promise<RecallResult[]> {
  try {
    return await withTimeout(
      recallKnowledge(query, { topK: 3, minScore: 0.35 }),
      900,
      'memory_recall_timeout',
    );
  } catch (error) {
    suppressedReasons.push(`memory_recall_unavailable:${(error as Error).message}`);
    return [];
  }
}

async function trySkillSearch(
  query: string,
  suppressedReasons: string[],
): Promise<SkillSearchResult[]> {
  try {
    return await withTimeout(
      getSkillRegistry().search(query, { topK: 3, minScore: 0.25 }),
      900,
      'skill_search_timeout',
    );
  } catch (error) {
    suppressedReasons.push(`skill_search_unavailable:${(error as Error).message}`);
    return [];
  }
}

async function tryAssembleContext(
  input: CodingPrecontextInput,
  maxTokens: number,
  suppressedReasons: string[],
): Promise<{ repoMap: string; checkpoint: string }> {
  try {
    const assembled = await assembleContext({
      description: input.userPrompt,
      repoPath: input.repoPath!,
      targetFiles: input.targetFiles ?? [],
      taskId: input.taskId,
      tokenBudget: Math.min(maxTokens, 1600),
      mentionedIdents: (input.targetFiles ?? []).map((file) =>
        file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '',
      ),
      includeRepoMap: input.includeRepoMap ?? true,
      includeRelevantCode: false,
      includeCheckpoint: input.includeCheckpoint ?? true,
    });
    return { repoMap: assembled.repoMap, checkpoint: assembled.checkpoint };
  } catch (error) {
    suppressedReasons.push(`context_assembly_unavailable:${(error as Error).message}`);
    return { repoMap: '', checkpoint: '' };
  }
}

function formatMemoryItems(items: RecallResult[], maxItemTokens: number): string {
  return items.map((item) => {
    const score = item.score > 0 ? ` score ${item.score.toFixed(2)},` : '';
    const content = truncateToTokens(item.content.replace(/\s+/g, ' '), maxItemTokens);
    return `- [${item.type}] ${item.title} (${score} confidence ${item.confidence.toFixed(2)}): ${content}`;
  }).join('\n');
}

function formatSkillItems(items: SkillSearchResult[]): string {
  return items.map((item) => {
    const description = item.metadata.description || 'No description';
    return `- ${item.metadata.name} (score ${item.score.toFixed(2)}): ${truncateToTokens(description, 80)}`;
  }).join('\n');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens) * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated to fit token budget)`;
}
