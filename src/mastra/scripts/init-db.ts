#!/usr/bin/env tsx
/**
 * Script: init-db
 * Inicjalizuje kolekcje MongoDB i zakłada wszystkie potrzebne indeksy.
 * Uruchom RAZ po pierwszym deployu:
 *   npx tsx src/mastra/scripts/init-db.ts
 *
 * Bezpieczny — używa createIndex (idempotentny).
 */
import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/agentforge';
const DB_NAME = MONGODB_URI.split('/').pop()?.split('?')[0] ?? 'agentforge';

async function main() {
  console.log(`🔗 Łączenie z MongoDB: ${MONGODB_URI}`);
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log(`📦 Baza danych: ${DB_NAME}\n`);

  // ── leads (CRM) ───────────────────────────────────────────────────────────
  console.log('📋 leads...');
  const leads = db.collection('leads');
  await leads.createIndex({ id: 1 }, { unique: true, sparse: true });
  await leads.createIndex({ email: 1 }, { sparse: true });
  await leads.createIndex({ status: 1 });
  await leads.createIndex({ segment: 1 });
  await leads.createIndex({ region: 1 });
  await leads.createIndex({ createdAt: -1 });
  await leads.createIndex({ lastInteractionAt: -1 });
  await leads.createIndex({ status: 1, lastInteractionAt: -1 });  // for stale lead queries

  // ── approvals ─────────────────────────────────────────────────────────────
  console.log('✅ approvals...');
  const approvals = db.collection('approvals');
  await approvals.createIndex({ id: 1 }, { unique: true });
  await approvals.createIndex({ status: 1 });
  await approvals.createIndex({ agentId: 1, status: 1 });
  await approvals.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 30 * 24 * 3600 },  // TTL: 30 days
  );

  // ── shared_memory ─────────────────────────────────────────────────────────
  console.log('🧠 shared_memory...');
  const mem = db.collection('shared_memory');
  await mem.createIndex({ key: 1 }, { unique: true });
  await mem.createIndex({ type: 1 });
  await mem.createIndex({ sourceAgent: 1 });
  await mem.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },  // TTL driven by the expiresAt field value
  );

  // ── signals ───────────────────────────────────────────────────────────────
  console.log('📡 signals...');
  const signals = db.collection('signals');
  await signals.createIndex({ type: 1 });
  await signals.createIndex({ sourceAgent: 1 });
  await signals.createIndex({ createdAt: -1 });
  await signals.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },  // TTL
  );

  // ── rss_articles ──────────────────────────────────────────────────────────
  console.log('📰 rss_articles...');
  const rss = db.collection('rss_articles');
  await rss.createIndex({ link: 1 }, { unique: true, sparse: true });
  await rss.createIndex({ pubDate: -1 });
  await rss.createIndex({ source: 1, pubDate: -1 });
  await rss.createIndex(
    { pubDate: 1 },
    { expireAfterSeconds: 30 * 24 * 3600 },  // keep articles 30 days
  );

  // ── rss_sources ───────────────────────────────────────────────────────────
  console.log('📡 rss_sources...');
  await db.collection('rss_sources').createIndex({ url: 1 }, { unique: true });

  // ── rss_digests ───────────────────────────────────────────────────────────
  console.log('📋 rss_digests...');
  const digests = db.collection('rss_digests');
  await digests.createIndex({ id: 1 }, { unique: true });
  await digests.createIndex({ createdAt: -1 });

  // ── reports ───────────────────────────────────────────────────────────────
  console.log('📊 reports...');
  const reports = db.collection('reports');
  await reports.createIndex({ id: 1 }, { unique: true, sparse: true });
  await reports.createIndex({ type: 1, generatedAt: -1 });

  // ── inbox_drafts ──────────────────────────────────────────────────────────
  console.log('📬 inbox_drafts...');
  const drafts = db.collection('inbox_drafts');
  await drafts.createIndex({ messageId: 1 }, { unique: true, sparse: true });
  await drafts.createIndex({ status: 1 });
  await drafts.createIndex({ createdAt: -1 });
  await drafts.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 7 * 24 * 3600 },  // 7 day TTL
  );

  // ── calendar_events ───────────────────────────────────────────────────────
  console.log('📅 calendar_events...');
  const cal = db.collection('calendar_events');
  await cal.createIndex({ leadId: 1 });
  await cal.createIndex({ attendeeEmail: 1 });
  await cal.createIndex({ startTime: 1 });
  await cal.createIndex({ status: 1 });

  // ── onboarding_checklists ─────────────────────────────────────────────────
  console.log('📋 onboarding_checklists...');
  await db.collection('onboarding_checklists').createIndex({ id: 1 }, { unique: true });

  // ── sync_meta ─────────────────────────────────────────────────────────────
  console.log('🔄 sync_meta...');
  await db.collection('sync_meta').createIndex({ key: 1 }, { unique: true });

  // ── gmail_messages ────────────────────────────────────────────────────────
  console.log('📧 gmail_messages...');
  const gmail = db.collection('gmail_messages');
  await gmail.createIndex({ messageId: 1 }, { unique: true, sparse: true });
  await gmail.createIndex({ direction: 1, sentAt: -1 });
  await gmail.createIndex({ direction: 1, receivedAt: -1 });
  await gmail.createIndex({ from: 1 });
  await gmail.createIndex({ to: 1 });

  // ── token_usage ───────────────────────────────────────────────────────────
  console.log('💰 token_usage...');
  const tokens = db.collection('token_usage');
  await tokens.createIndex({ timestamp: -1 });
  await tokens.createIndex({ agentId: 1, timestamp: -1 });
  await tokens.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 90 * 24 * 3600 },  // 90 day retention
  );

  // ── workflow_runs ─────────────────────────────────────────────────────────
  console.log('⚙️  workflow_runs...');
  const wfRuns = db.collection('workflow_runs');
  await wfRuns.createIndex({ workflowId: 1, startedAt: -1 });
  await wfRuns.createIndex({ status: 1 });
  await wfRuns.createIndex({ startedAt: -1 });
  await wfRuns.createIndex(
    { startedAt: 1 },
    { expireAfterSeconds: 90 * 24 * 3600 },
  );

  // ── chef collections ──────────────────────────────────────────────────────
  console.log('👨‍🍳 chef_projects / chef_menus / chef_recipes / chef_notes...');
  await db.collection('chef_projects').createIndex({ id: 1 }, { unique: true });
  await db.collection('chef_projects').createIndex({ chefId: 1, status: 1 });
  await db.collection('chef_menus').createIndex({ id: 1 }, { unique: true });
  await db.collection('chef_menus').createIndex({ projectId: 1 });
  await db.collection('chef_recipes').createIndex({ id: 1 }, { unique: true });
  await db.collection('chef_recipes').createIndex({ projectId: 1 });
  await db.collection('chef_notes').createIndex({ id: 1 }, { unique: true });
  await db.collection('chef_notes').createIndex({ projectId: 1, category: 1 });
  await db.collection('chef_notes').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  console.log('\n✅ Wszystkie indeksy założone pomyślnie.');
  await client.close();
}

main().catch((err) => {
  console.error('❌ Błąd inicjalizacji bazy:', err);
  process.exit(1);
});
