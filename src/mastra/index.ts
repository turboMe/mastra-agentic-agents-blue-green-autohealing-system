import { Mastra } from '@mastra/core/mastra';
import { OllamaGateway } from './lib/ollama-gateway';

import { PinoLogger } from '@mastra/loggers';
import { MongoDBStore } from '@mastra/mongodb';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';



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

// Scorers
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { metaToolCallAppropriatenessScorer } from './scorers/meta-agent-scorer';
import { marketingDraftingCompletenessScorer } from './scorers/marketing-agent-scorer';
import { architectRiskSoundnessScorer } from './scorers/automation-architect-scorer';

export const mastra: Mastra = new Mastra({
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
