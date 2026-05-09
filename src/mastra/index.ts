import { Mastra } from '@mastra/core/mastra';
import { OllamaGateway } from './lib/ollama-gateway';
import { OpenRouterGateway } from './lib/openrouter-gateway';

import { PinoLogger } from '@mastra/loggers';
import { MongoDBStore } from '@mastra/mongodb';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
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
      isolation: 'bwrap',
      nativeSandbox: {
        allowNetwork: true,
      },
    }),
    tools: {
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: 'read_file' },
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { name: 'write_file' },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: 'list_files' },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: 'search_content' },
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { name: 'execute_command' },
    },
  }),
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
import { getSkillRegistry } from './services/skill-registry.js';
import { resolve } from 'path';
getSkillRegistry().initialize(resolve(import.meta.dirname ?? '.', '_skills')).catch((err) =>
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
