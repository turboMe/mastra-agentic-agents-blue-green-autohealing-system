#!/usr/bin/env tsx
/**
 * Script: cron-runner
 * Uruchamia workflowy GastroBridge na podstawie harmonogramów.
 *
 * Uruchamiaj równolegle z `mastra dev` lub `mastra start`:
 *   npx tsx src/mastra/scripts/cron-runner.ts
 *
 * Alternatywnie zdefiniuj systemowy crontab / n8n schedule workflow,
 * który wywoła POST na endpoint Mastra:
 *   POST http://localhost:4111/api/workflows/{workflowId}/start
 *
 * Harmonogram:
 *   - morning-briefing:   codziennie 08:00
 *   - automated-followup: codziennie 10:00
 *   - sync-crm:           co 4h (8, 12, 16, 20)
 *   - inbox-monitor:      co 2h (8..22)
 *   - weekly-report:      poniedziałek 09:00
 *   - trend-analysis:     poniedziałek 10:00
 *   - roi-calculator:     pierwszy dzień miesiąca 07:00
 */

const MASTRA_BASE_URL = process.env.MASTRA_URL ?? 'http://localhost:4111';

// ── HTTP helper ────────────────────────────────────────────────────────────
async function triggerWorkflow(
  workflowId: string,
  inputData: Record<string, unknown> = {},
): Promise<void> {
  const url = `${MASTRA_BASE_URL}/api/workflows/${workflowId}/start`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputData),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[cron] ❌ ${workflowId} HTTP ${res.status}: ${text.slice(0, 200)}`);
    } else {
      const json = (await res.json()) as { runId?: string; status?: string };
      console.log(`[cron] ✅ ${workflowId} started — runId=${json.runId ?? '?'}`);
    }
  } catch (err) {
    console.error(`[cron] ❌ ${workflowId} fetch error:`, (err as Error).message);
  }
}

// ── Schedule definitions ───────────────────────────────────────────────────
interface ScheduleRule {
  /** Human-readable name for logging */
  name: string;
  /** workflowId as registered in index.ts */
  workflowId: string;
  /** Input data passed to the workflow */
  input?: Record<string, unknown>;
  /** Return true when this rule should fire (checked every minute) */
  matches: (now: Date) => boolean;
}

const SCHEDULES: ScheduleRule[] = [
  // Daily briefing — 08:00
  {
    name: 'morning-briefing',
    workflowId: 'morning-briefing',
    input: { maxArticles: 10, includeCrm: true },
    matches: (d) => d.getHours() === 8 && d.getMinutes() === 0,
  },
  // Automated follow-up drafts — 10:00 daily
  {
    name: 'automated-followup',
    workflowId: 'automated-followup',
    input: { daysWithoutResponse: 7, maxLeads: 10, status: 'sent' },
    matches: (d) => d.getHours() === 10 && d.getMinutes() === 0,
  },
  // Inbox monitor — every 2h (8, 10, 12, 14, 16, 18, 20, 22)
  {
    name: 'inbox-monitor',
    workflowId: 'inbox-monitor',
    input: { hoursBack: 2, maxResults: 20 },
    matches: (d) => d.getHours() % 2 === 0 && d.getMinutes() === 30,
  },
  // Sync Gmail → CRM — every 4h (8, 12, 16, 20)
  {
    name: 'sync-crm',
    workflowId: 'sync-crm',
    input: { hoursBack: 4, maxEmails: 50 },
    matches: (d) => d.getHours() % 4 === 0 && d.getMinutes() === 15,
  },
  // Weekly report — Monday 09:00
  {
    name: 'weekly-report',
    workflowId: 'weekly-report',
    input: { periodDays: 7 },
    matches: (d) => d.getDay() === 1 && d.getHours() === 9 && d.getMinutes() === 0,
  },
  // Trend analysis — Monday 10:00
  {
    name: 'trend-analysis',
    workflowId: 'trend-analysis',
    input: { periodDays: 14, comparisonPeriodDays: 14 },
    matches: (d) => d.getDay() === 1 && d.getHours() === 10 && d.getMinutes() === 0,
  },
  // ROI calculator — 1st day of month 07:00
  {
    name: 'roi-calculator',
    workflowId: 'roi-calculator',
    input: { periodDays: 30, costPerMillionTokens: 0.15, avgDealValuePLN: 5000 },
    matches: (d) => d.getDate() === 1 && d.getHours() === 7 && d.getMinutes() === 0,
  },
];

// ── Tick every minute ──────────────────────────────────────────────────────
let lastTickMinute = -1;

function tick() {
  const now = new Date();
  const minuteKey = now.getHours() * 60 + now.getMinutes();

  // Prevent double-firing within the same minute
  if (minuteKey === lastTickMinute) return;
  lastTickMinute = minuteKey;

  for (const rule of SCHEDULES) {
    if (rule.matches(now)) {
      const ts = now.toISOString().slice(11, 16);
      console.log(`[cron] 🕐 ${ts} → triggering ${rule.name}`);
      void triggerWorkflow(rule.workflowId, rule.input ?? {});
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`[cron] 🚀 GastroBridge cron runner started`);
console.log(`[cron] 🔗 Mastra URL: ${MASTRA_BASE_URL}`);
console.log(`[cron] 📅 ${SCHEDULES.length} schedules active:\n`);
for (const s of SCHEDULES) {
  console.log(`  • ${s.name}`);
}
console.log();

// First tick immediately so we pick up any jobs that should run at startup
tick();

// Then every 30s (two checks per minute to avoid drift)
setInterval(tick, 30_000);

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n[cron] 👋 Shutting down...');
  process.exit(0);
});
