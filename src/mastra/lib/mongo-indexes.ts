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

  console.log('[MongoIndexes] TTL indexes ensured for: signals, shared_memory, auto_healing_tickets');
}
