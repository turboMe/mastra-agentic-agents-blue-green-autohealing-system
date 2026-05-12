import { Mastra } from '@mastra/core/mastra';
import { OllamaGateway } from './lib/ollama-gateway';
import { OpenRouterGateway } from './lib/openrouter-gateway';

import { PinoLogger } from '@mastra/loggers';
import { MongoDBStore } from '@mastra/mongodb';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { MastraEditor } from '@mastra/editor';
import { MongoTelemetryExporter } from './services/mongo-telemetry-exporter.js';
import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';

// Self-healing (Etap 7)
import { initGlobalErrorHandlers } from './services/global-error-handler.js';
import { getErrorCollector } from './services/error-collector.js';

// GPU Guard (Etap 8 — VRAM protection)
import { initGpuGuard, getGpuGuard } from './services/gpu-guard.js';

// Model Availability (Etap 8.1 — verify models at startup)
import { initModelAvailability } from './services/model-availability.js';



// Workflows
import { weatherWorkflow } from './workflows/weather-workflow';
import { weeklyContentWorkflow } from './workflows/weekly-content';
import { producerHuntWorkflow } from './workflows/producer-hunt';
import { morningBriefingWorkflow } from './workflows/marketing/morning-briefing';
import { automatedFollowupWorkflow } from './workflows/marketing/automated-followup';
import { inboxMonitorWorkflow } from './workflows/marketing/inbox-monitor';
import { syncCrmWorkflow } from './workflows/marketing/sync-crm';
import { weeklyReportWorkflow } from './workflows/analytics/weekly-report';
import { roiCalculatorWorkflow } from './workflows/analytics/roi-calculator';
import { trendAnalysisWorkflow } from './workflows/analytics/trend-analysis';
import { proposalGeneratorWorkflow } from './workflows/sales/proposal-generator';
import { meetingSchedulerWorkflow } from './workflows/sales/meeting-scheduler';
import { onboardingChecklistWorkflow } from './workflows/sales/onboarding-checklist';
import { repoMaintenanceWorkflow } from './workflows/repo-maintenance';
import { automationClientHuntStrategyWorkflow } from './workflows/automation-client-hunt-strategy';

// Agents
import { weatherAgent } from './agents/weather-agent';
import { crmAgent } from './agents/crm-agent';
import { metaAgent } from './agents/meta-agent';
import {
  marketingAgent,
  producerHuntDiscoveryAgent,
  producerHuntDraftAgent,
  producerHuntEmailExtractionAgent,
  producerHuntEnrichmentAgent,
  producerHuntJsonRepairAgent,
  producerHuntCloudFallbackAgent,
} from './agents/marketing-agent';
import { salesAgent } from './agents/sales-agent';
import { analyticsAgent } from './agents/analytics-agent';
import { automationArchitect } from './agents/automation-architect';
import { codingAgent } from './agents/coding-agent';
import { codeReviewAgent } from './agents/code-review-agent';
import { knowledgeAgent } from './agents/knowledge-agent';
import { researcherAgent } from './agents/researcher-agent';

// Scorers
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { metaToolCallAppropriatenessScorer } from './scorers/meta-agent-scorer';
import { marketingDraftingCompletenessScorer } from './scorers/marketing-agent-scorer';
import { architectRiskSoundnessScorer } from './scorers/automation-architect-scorer';

// Server (custom API routes)
import { registerApiRoute } from '@mastra/core/server';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const startedAt = Date.now();

function getVersion(): string {
  // Próbuj git (live repo)
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    // Fallback: plik .deploy-version (staging bez .git)
    try {
      return readFileSync('.deploy-version', 'utf-8').trim();
    } catch {
      return 'unknown';
    }
  }
}

const APP_VERSION = getVersion();

export const mastra: Mastra = new Mastra({
  server: {
    apiRoutes: [
      registerApiRoute('/deploy/health', {
        method: 'GET',
        handler: async (c) => {
          const uptimeMs = Date.now() - startedAt;
          return c.json({
            status: 'ok',
            version: APP_VERSION,
            uptime: uptimeMs,
            uptimeHuman: `${Math.floor(uptimeMs / 60000)}m ${Math.floor((uptimeMs % 60000) / 1000)}s`,
            timestamp: new Date().toISOString(),
            slot: process.env.DEPLOY_SLOT || 'default',
            port: process.env.PORT || '4111',
            pid: process.pid,
          });
        },
      }),
      // ── Google OAuth Flow (Faza 6.1) ──
      registerApiRoute('/auth/google', {
        method: 'GET',
        handler: async (c: any) => {
          const { getGoogleAuthUrl } = await import('./tools/google/auth.js');
          const url = getGoogleAuthUrl();
          return c.redirect(url);
        },
      }),
      registerApiRoute('/auth/google/callback', {
        method: 'GET',
        handler: async (c: any) => {
          const { exchangeGoogleCode } = await import('./tools/google/auth.js');
          const url = new URL(c.req.url, 'http://localhost');
          const code = url.searchParams.get('code');

          if (!code) {
            return c.json({ error: 'No code provided' }, 400);
          }

          try {
            const tokens = await exchangeGoogleCode(code);
            return c.json({
              message: 'OAuth successful! Update your GOOGLE_REFRESH_TOKEN in .env',
              ...tokens
            });
          } catch (err: any) {
            return c.json({ error: err.message }, 500);
          }
        },
      }),
      // ── Self-healing: crash-test endpoint (Etap 7) ──
      registerApiRoute('/deploy/crash-test', {
        method: 'GET',
        handler: async (c: any) => {
          // Symulowany błąd do testowania ErrorCollector
          const errorType = new URL(c.req.url, 'http://localhost').searchParams.get('type') || 'TypeError';
          const simulatedError = new TypeError('Cannot read property \'value\' of undefined');
          simulatedError.name = errorType;

          const collector = getErrorCollector();
          const result = await collector.reportError(simulatedError, {
            source: 'api',
            origin: '/deploy/crash-test',
            metadata: { simulated: true },
          });

          return c.json({
            crashSimulated: true,
            healingTriggered: result.triggered,
            reason: result.reason,
            ticketId: result.ticketId,
            timestamp: new Date().toISOString(),
          });
        },
      }),
      // ── Self-healing: status aktywnych napraw ──
      registerApiRoute('/deploy/auto-heal-status', {
        method: 'GET',
        handler: async (c: any) => {
          const collector = getErrorCollector();
          const tickets = await collector.getActiveTickets();
          return c.json({
            activeTickets: tickets.length,
            tickets,
            timestamp: new Date().toISOString(),
          });
        },
      }),
      // ── GPU Guard: VRAM monitoring endpoint ──
      registerApiRoute('/deploy/gpu-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const guard = getGpuGuard();
            const snapshot = guard.getSnapshot(true);
            return c.json({
              ...snapshot,
              timestamp: snapshot.timestamp.toISOString(),
              vramBudgetMb: (await import('./config/model-capabilities.js')).VRAM_BUDGET_MB,
            });
          } catch (err) {
            return c.json({
              error: 'GpuGuard unavailable',
              message: (err as Error).message,
              gpuAvailable: false,
            }, 500);
          }
        },
      }),
      // ── Model Availability: check model status (Etap 8.1) ──
      registerApiRoute('/deploy/model-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { verifyAllModels, formatAvailabilitySummary } = await import('./services/model-availability.js');
            const forceRefresh = new URL(c.req.url, 'http://localhost').searchParams.get('refresh') === 'true';
            const summary = await verifyAllModels(forceRefresh);
            return c.json({
              ...summary,
              checkedAt: summary.checkedAt.toISOString(),
              formatted: formatAvailabilitySummary(summary),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/deploy/github-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getGitHubStatus } = await import('./services/github.js');
            const status = await getGitHubStatus();
            return c.json(status);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Cloud-free tier diagnostics (Phase 4.2/4.3) ──
      registerApiRoute('/deploy/cloud-free-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getCircuitBreaker } = await import('./services/circuit-breaker.js');
            const { getBudgetTracker } = await import('./services/budget-tracker.js');
            const breaker = getCircuitBreaker();
            const budget = getBudgetTracker();
            return c.json({
              budget: budget.getDailySummary('openrouter'),
              circuitBreakers: breaker.getOpenCircuits(),
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Agent Evaluation Dashboard (Faza 7.6 — Sprint 1) ──
      // Read-only aggregation endpoints. All accept ?since=7d|24h|YYYY-MM-DD
      // and optional ?until=YYYY-MM-DD. Defaults to last 7 days.
      registerApiRoute('/dashboard/overview', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json(await stats.getOverview(window));
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/agents', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getAgentSuccessRates(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/skills', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getSkillUsageStats(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/models', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getModelBreakdown(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/latency', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getLatencyPercentiles(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/cost', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getCostBreakdown(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/scores', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getScoreStats(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/timeline', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const granParam = url.searchParams.get('granularity');
            const granularity = granParam === 'day' ? 'day' : 'hour';
            return c.json({ data: await stats.getTimeline(window, granularity), window, granularity });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Live Agent Activity (delegations + tool calls timeline) ──
      // Powers the "Live Activity" tab. Returns recent agent_events for live polling.
      registerApiRoute('/dashboard/agent-activity', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getDb } = await import('./lib/mongo.js');
            const db = await getDb();
            const url = new URL(c.req.url, 'http://localhost');
            const sinceParam = url.searchParams.get('since');
            const limitParam = parseInt(url.searchParams.get('limit') ?? '100', 10);
            const limit = Math.min(Math.max(limitParam, 1), 500);

            const since = sinceParam
              ? new Date(sinceParam)
              : new Date(Date.now() - 5 * 60 * 1000); // default: ostatnie 5 min

            const events = await db.collection('agent_events')
              .find({ timestamp: { $gte: since } })
              .sort({ timestamp: -1 })
              .limit(limit)
              .project({
                _id: 0,
                eventId: 1,
                timestamp: 1,
                agentId: 1,
                type: 1,
                toolId: 1,
                taskId: 1,
                status: 1,
                durationMs: 1,
                input: 1,
                output: 1,
                errorMessage: 1,
                model: 1,
                tokenUsage: 1,
                metadata: 1,
              })
              .toArray();

            return c.json({
              events,
              count: events.length,
              since: since.toISOString(),
              now: new Date().toISOString(),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Dashboard UI (Faza 7.6 — Sprint 2) ──
      // Single-file HTML + Chart.js, no build step. Consumes /dashboard/* JSON endpoints.
      registerApiRoute('/dashboard-ui', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            // Hardcoded source path (bundled mode resolves import.meta.dirname to .mastra/output/)
            const htmlPath = path.resolve(
              '/projekty/mastra-agentic-environment/agentic-agents',
              'dashboard',
              'index.html',
            );
            const html = await fs.readFile(htmlPath, 'utf8');
            return c.html(html);
          } catch (err) {
            return c.json({ error: 'Dashboard UI not found', details: (err as Error).message }, 500);
          }
        },
      }),
    ],
  },
  workflows: {
    weatherWorkflow,
    weeklyContentWorkflow,
    producerHuntWorkflow,
    // marketing
    morningBriefingWorkflow,
    automatedFollowupWorkflow,
    inboxMonitorWorkflow,
    syncCrmWorkflow,
    // analytics
    weeklyReportWorkflow,
    roiCalculatorWorkflow,
    trendAnalysisWorkflow,
    // sales
    proposalGeneratorWorkflow,
    meetingSchedulerWorkflow,
    onboardingChecklistWorkflow,
    repoMaintenanceWorkflow,
    automationClientHuntStrategyWorkflow,
  },
  agents: {
    weatherAgent,
    crmAgent,
    metaAgent,
    marketingAgent,
    producerHuntDiscoveryAgent,
    producerHuntEnrichmentAgent,
    producerHuntEmailExtractionAgent,
    producerHuntDraftAgent,
    producerHuntJsonRepairAgent,
    producerHuntCloudFallbackAgent,
    salesAgent,
    analyticsAgent,
    automationArchitect,
    codingAgent,
    codeReviewAgent,
    knowledgeAgent,
    researcherAgent,
  },
  scorers: {
    toolCallAppropriatenessScorer,
    completenessScorer,
    translationScorer,
    metaToolCallAppropriatenessScorer,
    marketingDraftingCompletenessScorer,
    architectRiskSoundnessScorer,
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new MongoDBStore({
      id: 'mastra-mongodb-storage',
      url: process.env.MONGODB_URI || 'mongodb://localhost:27017/agentforge',
      dbName: 'agentforge',
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(),
          new CloudExporter(),
          // Telemetry → MongoDB agent_events collection (Faza 7.6 — feeds dashboard)
          new MongoTelemetryExporter(),
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
        ],
      },
    },
  }),
  workspace: new Workspace({
    filesystem: new LocalFilesystem({ basePath: '/projekty/Jarvis-Projects' }),
    sandbox: new LocalSandbox({
      workingDirectory: '/projekty/Jarvis-Projects',
      // bwrap nie dziala na tym hoscie (Permission denied przy uid map).
      // Spojnie z coding-workspace: env-driven, default 'none'.
      isolation:
        process.env.META_SANDBOX_ISOLATION === 'bwrap' ||
        process.env.META_SANDBOX_ISOLATION === 'seatbelt'
          ? process.env.META_SANDBOX_ISOLATION
          : 'none',
      nativeSandbox: {
        allowNetwork: true,
      },
    }),
    tools: {
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: 'read_file' },
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { name: 'write_file' },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: 'list_files' },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: 'search_content' },
      // SANDBOX.EXECUTE_COMMAND DEZAKTYWOWANY — emituje data-workspace-metadata
      // + data-sandbox-exit, ktore w Mastra v1.31/1.32 lamia persistencje text part.
      // Zastapione custom toolem `metaExecuteCommandTool` (child_process.spawn) w meta-agent.
    },
  }),
  editor: new MastraEditor(),
});


mastra.addGateway(new OllamaGateway());

// ── OpenRouter: cloud-free tier (Phase 4.1) ──
if (process.env.OPENROUTER_API_KEY) {
  mastra.addGateway(new OpenRouterGateway());
  console.log('[Mastra] OpenRouter gateway registered (cloud-free tier enabled)');
} else {
  console.log('[Mastra] OpenRouter gateway skipped (OPENROUTER_API_KEY not set)');
}

// ── Self-healing: Global Error Handlers (Etap 7) ──
initGlobalErrorHandlers();

// ── GPU Guard: VRAM Protection (Etap 8) ──
initGpuGuard();

initModelAvailability().catch((err) =>
  console.error('[ModelAvailability] Startup check failed:', (err as Error).message),
);

// ── Mongo TTL Indexes (Phase 0 — Bug #2.9) ──
import { ensureIndexes } from './lib/mongo-indexes.js';
ensureIndexes().catch((err) =>
  console.error('[MongoIndexes] Failed to ensure indexes:', (err as Error).message),
);

// ── Skill Registry (Phase 2.2) ──
// NOTE: import.meta.dirname resolves to .mastra/output/ in bundled mode,
// so we use explicit source path to find _skills/ directory.
import { getSkillRegistry } from './services/skill-registry.js';
import { AGENTIC_AGENTS_REPO } from './workspaces/code-workspace.js';
import { resolve } from 'path';
const SKILLS_DIR = process.env.MASTRA_SKILLS_DIR
  ? resolve(process.env.MASTRA_SKILLS_DIR)
  : resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', '_skills');
getSkillRegistry().initialize(SKILLS_DIR).catch((err) =>
  console.error('[SkillRegistry] Initialization failed:', (err as Error).message),
);

// ── Repo Indexer (Phase 5 — Structural Code Navigation) ──
import { getRepoIndexer } from './services/repo-indexer.js';
getRepoIndexer('/projekty/mastra-agentic-environment/agentic-agents').index().then((result) =>
  console.log(`[RepoIndexer] Startup scan: ${result.total} files, ${result.indexed} indexed in ${result.durationMs}ms`),
).catch((err) =>
  console.error('[RepoIndexer] Startup scan failed:', (err as Error).message),
);

// ── Graceful Shutdown for Dev/Hot-Reload ──
function cleanupAndExit(signal: string) {
  console.log(`[Mastra] Otrzymano sygnał ${signal}. Zamykanie zasobów przed restartem (Graceful Shutdown)...`);
  // Zmuszamy proces do całkowitego zakończenia, co uwalnia porty (np. 4111) oraz zdejmuje locki z DuckDB.
  // Środowisko deweloperskie (nodemon / mastra dev) automatycznie uruchomi nowy proces po tym, jak ten zginie.
  process.exit(0);
}

process.once('SIGUSR2', () => cleanupAndExit('SIGUSR2')); // Nodemon / TS-node dev restart
process.once('SIGTERM', () => cleanupAndExit('SIGTERM')); // Systemctl stop / standard kill
process.once('SIGINT', () => cleanupAndExit('SIGINT'));   // Ctrl+C
