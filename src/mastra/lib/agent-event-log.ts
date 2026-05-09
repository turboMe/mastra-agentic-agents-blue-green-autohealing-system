/**
 * Agent Event Log (Phase 1.2)
 *
 * Centralized, structured log of ALL significant agent events.
 * Used as input for Memory Extractor (Phase 1.3) and Failure Brain (Phase 2).
 *
 * Events have a 30-day TTL by default. Memory Extractor compresses
 * recurring patterns into permanent system_knowledge.
 */
import { randomUUID } from 'crypto';
import { getDb } from './mongo.js';

// ── Event Types ──────────────────────────────────────────────────────────────

export type AgentEventType =
  | 'task_started' | 'task_completed' | 'task_failed'
  | 'tool_called' | 'tool_error'
  | 'delegation' | 'escalation'
  | 'retry_success' | 'retry_failed'
  | 'autoheal_triggered' | 'autoheal_resolved'
  | 'lesson_learned' | 'skill_used'
  | 'approval_requested' | 'approval_granted' | 'approval_denied';

// ── Event Schema ─────────────────────────────────────────────────────────────

export interface AgentEvent {
  eventId: string;
  type: AgentEventType;
  timestamp: Date;
  agentId: string;
  taskId?: string;
  subtaskId?: string;
  model?: string;
  toolId?: string;
  input?: string;           // truncated (max 500 chars)
  output?: string;          // truncated (max 500 chars)
  status: 'success' | 'error' | 'pending';
  errorMessage?: string;
  durationMs?: number;
  tokenUsage?: { prompt: number; completion: number };
  metadata?: Record<string, unknown>;
  expiresAt: Date;
}

// ── Helper ───────────────────────────────────────────────────────────────────

function truncate(text: string | undefined, maxLen = 500): string | undefined {
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

const DEFAULT_TTL_DAYS = 30;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Log a single agent event.
 * Fire-and-forget safe — errors are caught and logged, never thrown.
 */
export async function logAgentEvent(
  event: Omit<AgentEvent, 'eventId' | 'timestamp' | 'expiresAt'>,
): Promise<void> {
  try {
    const db = await getDb();
    await db.collection('agent_events').insertOne({
      ...event,
      input: truncate(event.input),
      output: truncate(event.output),
      eventId: randomUUID(),
      timestamp: new Date(),
      expiresAt: new Date(Date.now() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
    });
  } catch (err) {
    console.warn('[AgentEventLog] Failed to log event:', (err as Error).message);
  }
}

/**
 * Query recent events by type and/or agentId.
 */
export async function queryAgentEvents(
  filter: {
    type?: AgentEventType;
    agentId?: string;
    taskId?: string;
    since?: Date;
    limit?: number;
  } = {},
): Promise<AgentEvent[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};

  if (filter.type) query.type = filter.type;
  if (filter.agentId) query.agentId = filter.agentId;
  if (filter.taskId) query.taskId = filter.taskId;
  if (filter.since) query.timestamp = { $gte: filter.since };

  return db
    .collection<AgentEvent>('agent_events')
    .find(query)
    .sort({ timestamp: -1 })
    .limit(filter.limit ?? 50)
    .toArray() as unknown as AgentEvent[];
}
