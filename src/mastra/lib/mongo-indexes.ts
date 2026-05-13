/**
 * Mongo Indexes — ensures TTL and performance indexes exist.
 * Called once at Mastra startup.
 *
 * Phase 0 — Bug #2.9: TTL indexes for auto-expiration.
 */
import { getDb } from './mongo.js';

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  // ── TTL Indexes (auto-delete expired documents) ────────────────────────
  await db.collection('signals').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('shared_memory').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('auto_healing_tickets').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );

  // ── Agent Event Log indexes (Phase 1.2) ────────────────────────────────
  await db.collection('agent_events').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('agent_events').createIndex({ type: 1, timestamp: -1 });
  await db.collection('agent_events').createIndex({ agentId: 1, timestamp: -1 });
  await db.collection('agent_events').createIndex({ taskId: 1 });

  // ── Harness run state indexes ───────────────────────────────────────────
  await db.collection('agent_runs').createIndex({ runId: 1 }, { unique: true });
  await db.collection('agent_runs').createIndex({ taskId: 1, updatedAt: -1 });
  await db.collection('agent_runs').createIndex({ threadId: 1, updatedAt: -1 });
  await db.collection('agent_runs').createIndex({ status: 1, updatedAt: -1 });
  await db.collection('agent_run_events').createIndex({ runId: 1, timestamp: 1 });
  await db.collection('agent_run_events').createIndex({ taskId: 1, timestamp: -1 });
  await db.collection('agent_run_events').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );

  // ── System Knowledge indexes (Phase 1.3) ───────────────────────────────
  await db.collection('system_knowledge').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('system_knowledge').createIndex({ type: 1, createdAt: -1 });
  await db.collection('system_knowledge').createIndex({ knowledgeId: 1 }, { unique: true });

  // ── Async semantic memory indexes (Harness Etap 2) ─────────────────────
  await db.collection('pending_memory_context').createIndex({ threadId: 1, status: 1, computedAt: -1 });
  await db.collection('pending_memory_context').createIndex({ taskId: 1, status: 1, computedAt: -1 });
  await db.collection('pending_memory_context').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('injected_memory_context').createIndex(
    { threadId: 1, memoryId: 1 }, { unique: true },
  );
  await db.collection('injected_memory_context').createIndex(
    { injectedAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 },
  );

  console.log('[MongoIndexes] TTL indexes ensured for: signals, shared_memory, auto_healing_tickets, agent_events, agent_run_events, system_knowledge, pending_memory_context, injected_memory_context');
}
