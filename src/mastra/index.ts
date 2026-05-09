import { Mastra } from '@mastra/core/mastra';
import { OllamaGateway } from './lib/ollama-gateway';

import { PinoLogger } from '@mastra/loggers';
import { MongoDBStore } from '@mastra/mongodb';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';

// Self-healing (Etap 7)
import { initGlobalErrorHandlers } from './services/global-error-handler.js';
import { getErrorCollector } from './services/error-collector.js';



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

// ── Self-healing: Global Error Handlers (Etap 7) ──
initGlobalErrorHandlers();
