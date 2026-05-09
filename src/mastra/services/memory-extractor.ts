/**
 * Memory Extractor (Phase 1.3)
 *
 * Background worker that analyzes `agent_events` and extracts
 * typed knowledge patterns into `system_knowledge`.
 *
 * Extraction patterns:
 *   1. retry_success + task_failed in same taskId → failure_case
 *   2. Repeated tool_error with same errorMessage → tool_contract
 *   3. autoheal_triggered + autoheal_resolved → autoheal_recipe
 *   4. delegation with high durationMs → prompt_rule (costly prompt)
 *
 * Knowledge has 90-day TTL (renewable on recall).
 *
 * Usage:
 *   import { extractKnowledge } from './services/memory-extractor.js';
 *   const extracted = await extractKnowledge();
 *   console.log(`Extracted ${extracted} knowledge items`);
 */

import { randomUUID } from 'crypto';
import { getDb } from '../lib/mongo.js';
import { generateEmbedding } from '../lib/embedder.js';
import type { AgentEvent, AgentEventType } from '../lib/agent-event-log.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type KnowledgeType =
  | 'failure_case'
  | 'coding_pattern'
  | 'autoheal_recipe'
  | 'tool_contract'
  | 'prompt_rule'
  | 'user_preference'
  | 'project_fact'
  | 'architecture_decision'
  | 'system_diagnostic'
  | 'workflow_result'
  | 'operational_note'
  | 'env_config';

export interface SystemKnowledge {
  knowledgeId: string;
  type: KnowledgeType;
  title: string;
  content: string;
  embedding: number[];
  sourceEventIds: string[];
  confidence: number;       // 0–1
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

// ── Config ───────────────────────────────────────────────────────────────────

const KNOWLEDGE_TTL_DAYS = 90;
const MAX_EVENTS_PER_RUN = 500;

/** Metadata key to track last extraction run */
const LAST_RUN_KEY = 'memory_extractor_last_run';

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text: string, max = 1000): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

async function getLastRunTimestamp(): Promise<Date> {
  const db = await getDb();
  const meta = await db.collection('system_metadata').findOne({ key: LAST_RUN_KEY });
  return meta?.value ? new Date(meta.value as string) : new Date(0);
}

async function setLastRunTimestamp(ts: Date): Promise<void> {
  const db = await getDb();
  await db.collection('system_metadata').updateOne(
    { key: LAST_RUN_KEY },
    { $set: { key: LAST_RUN_KEY, value: ts.toISOString() } },
    { upsert: true },
  );
}

async function saveKnowledge(
  type: KnowledgeType,
  title: string,
  content: string,
  sourceEventIds: string[],
  confidence: number,
): Promise<string> {
  const db = await getDb();
  const knowledgeId = randomUUID();
  const now = new Date();

  let embedding: number[] = [];
  try {
    embedding = await generateEmbedding(title);
  } catch (err) {
    console.warn('[MemoryExtractor] Embedding failed, saving without vector:', (err as Error).message);
  }

  // Check for duplicate by title similarity (exact title match)
  const existing = await db.collection<SystemKnowledge>('system_knowledge').findOne({
    type,
    title,
  });

  if (existing) {
    // Update existing knowledge — refresh TTL and merge event IDs
    await db.collection('system_knowledge').updateOne(
      { knowledgeId: existing.knowledgeId },
      {
        $set: {
          content,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000),
          embedding,
          confidence: Math.min(1, existing.confidence + 0.1), // grows with repetition
        },
        $addToSet: { sourceEventIds: { $each: sourceEventIds } },
      },
    );
    return existing.knowledgeId;
  }

  const doc: SystemKnowledge = {
    knowledgeId,
    type,
    title,
    content: truncate(content),
    embedding,
    sourceEventIds,
    confidence,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000),
  };

  await db.collection('system_knowledge').insertOne(doc as any);
  return knowledgeId;
}

// ── Pattern Detectors ────────────────────────────────────────────────────────

/**
 * Pattern 1: retry_success events → failure_case
 * A retry that succeeded means the first attempt failed for an identifiable reason.
 */
async function extractRetryPatterns(events: AgentEvent[]): Promise<number> {
  const retrySuccesses = events.filter(e => e.type === 'retry_success');
  let count = 0;

  for (const event of retrySuccesses) {
    if (!event.taskId) continue;

    const title = `Retry success: ${event.subtaskId ?? event.taskId}`;
    const content = [
      `Agent: ${event.agentId}`,
      `Model: ${event.model ?? 'unknown'}`,
      `Task: ${event.taskId}`,
      event.subtaskId ? `Subtask: ${event.subtaskId}` : '',
      event.output ? `Result: ${event.output}` : '',
      event.metadata ? `Context: ${JSON.stringify(event.metadata)}` : '',
    ].filter(Boolean).join('\n');

    await saveKnowledge('failure_case', title, content, [event.eventId], 0.7);
    count++;
  }

  return count;
}

/**
 * Pattern 2: Repeated tool_error with same errorMessage → tool_contract
 */
async function extractToolErrorPatterns(events: AgentEvent[]): Promise<number> {
  const toolErrors = events.filter(e => e.type === 'tool_error' && e.errorMessage);
  const errorGroups = new Map<string, AgentEvent[]>();

  for (const event of toolErrors) {
    const key = `${event.toolId ?? 'unknown'}::${event.errorMessage!.slice(0, 100)}`;
    const group = errorGroups.get(key) ?? [];
    group.push(event);
    errorGroups.set(key, group);
  }

  let count = 0;
  for (const [key, group] of errorGroups) {
    if (group.length < 2) continue; // only extract if pattern repeats

    const [toolId, errPrefix] = key.split('::');
    const title = `Tool contract violation: ${toolId} — ${errPrefix}`;
    const content = [
      `Tool: ${toolId}`,
      `Error pattern: ${errPrefix}`,
      `Occurrences: ${group.length}`,
      `Models involved: ${[...new Set(group.map(e => e.model))].join(', ')}`,
      `Fix: Review tool input validation or update agent instructions for ${toolId}`,
    ].join('\n');

    const eventIds = group.map(e => e.eventId);
    await saveKnowledge('tool_contract', title, content, eventIds, Math.min(1, 0.5 + group.length * 0.1));
    count++;
  }

  return count;
}

/**
 * Pattern 3: autoheal_triggered → autoheal_recipe
 */
async function extractAutohealPatterns(events: AgentEvent[]): Promise<number> {
  const heals = events.filter(e => e.type === 'autoheal_triggered' || e.type === 'autoheal_resolved');
  let count = 0;

  for (const event of heals) {
    if (event.type !== 'autoheal_triggered') continue;

    const resolved = heals.find(e =>
      e.type === 'autoheal_resolved' && e.taskId === event.taskId
    );

    const title = `Autoheal: ${event.input?.slice(0, 80) ?? event.taskId ?? 'unknown'}`;
    const content = [
      `Trigger: ${event.input ?? 'unknown error'}`,
      `Source: ${(event.metadata as any)?.source ?? 'unknown'}`,
      `Origin: ${(event.metadata as any)?.origin ?? 'unknown'}`,
      resolved ? `Resolution: successful` : `Resolution: pending/unknown`,
    ].join('\n');

    await saveKnowledge('autoheal_recipe', title, content, [event.eventId], resolved ? 0.9 : 0.5);
    count++;
  }

  return count;
}

/**
 * Pattern 4: delegation with high duration → prompt_rule
 */
async function extractCostlyDelegations(events: AgentEvent[]): Promise<number> {
  const delegations = events.filter(e =>
    e.type === 'delegation' && e.durationMs && e.durationMs > 60_000
  );
  let count = 0;

  for (const event of delegations) {
    const title = `Costly delegation: ${event.agentId} (${Math.round(event.durationMs! / 1000)}s)`;
    const content = [
      `Agent: ${event.agentId}`,
      `Duration: ${event.durationMs}ms`,
      `Input preview: ${event.input?.slice(0, 200) ?? 'N/A'}`,
      `Recommendation: Consider splitting task or reducing prompt size for ${event.agentId}`,
    ].join('\n');

    await saveKnowledge('prompt_rule', title, content, [event.eventId], 0.6);
    count++;
  }

  return count;
}

/**
 * Pattern 5: task_failed with no retry → direct failure case
 */
async function extractDirectFailures(events: AgentEvent[]): Promise<number> {
  const failures = events.filter(e => e.type === 'task_failed' && e.errorMessage);
  const retryTaskIds = new Set(
    events.filter(e => e.type === 'retry_success').map(e => e.taskId).filter(Boolean),
  );

  let count = 0;
  for (const event of failures) {
    // Skip if this task had a successful retry (already captured by pattern 1)
    if (event.taskId && retryTaskIds.has(event.taskId)) continue;

    const title = `Unrecovered failure: ${event.errorMessage?.slice(0, 80) ?? 'unknown'}`;
    const content = [
      `Agent: ${event.agentId}`,
      `Model: ${event.model ?? 'unknown'}`,
      `Task: ${event.taskId ?? 'N/A'}`,
      `Error: ${event.errorMessage}`,
      event.metadata ? `Context: ${JSON.stringify(event.metadata)}` : '',
    ].filter(Boolean).join('\n');

    await saveKnowledge('failure_case', title, content, [event.eventId], 0.8);
    count++;
  }

  return count;
}

// ── Main Extraction Function ─────────────────────────────────────────────────

/**
 * Run one extraction cycle.
 * Fetches new events since last run, applies all pattern detectors,
 * and saves extracted knowledge to system_knowledge.
 *
 * @returns Number of knowledge items extracted/updated
 */
export async function extractKnowledge(): Promise<number> {
  const since = await getLastRunTimestamp();
  const now = new Date();

  const db = await getDb();
  const events = await db
    .collection<AgentEvent>('agent_events')
    .find({ timestamp: { $gt: since } })
    .sort({ timestamp: 1 })
    .limit(MAX_EVENTS_PER_RUN)
    .toArray() as unknown as AgentEvent[];

  if (events.length === 0) {
    console.log('[MemoryExtractor] No new events since', since.toISOString());
    return 0;
  }

  console.log(`[MemoryExtractor] Processing ${events.length} events since ${since.toISOString()}`);

  let total = 0;
  total += await extractRetryPatterns(events);
  total += await extractToolErrorPatterns(events);
  total += await extractAutohealPatterns(events);
  total += await extractCostlyDelegations(events);
  total += await extractDirectFailures(events);

  await setLastRunTimestamp(now);

  console.log(`[MemoryExtractor] Extracted ${total} knowledge items`);
  return total;
}

/**
 * Renew TTL on a knowledge item (called when it's recalled).
 * This prevents useful knowledge from expiring.
 */
export async function renewKnowledgeTTL(knowledgeId: string): Promise<void> {
  const db = await getDb();
  await db.collection('system_knowledge').updateOne(
    { knowledgeId },
    {
      $set: {
        expiresAt: new Date(Date.now() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000),
        updatedAt: new Date(),
      },
      $inc: { usageCount: 1 },
    },
  );
}
