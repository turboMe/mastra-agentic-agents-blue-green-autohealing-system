import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { updateStatusTool } from '../tools/crm/update-status.js';
import { addInteractionTool } from '../tools/crm/add-interaction.js';
import { searchLeadsTool } from '../tools/crm/search-leads.js';
import { createLeadTool } from '../tools/crm/create-lead.js';
import { updateLeadTool } from '../tools/crm/update-lead.js';
import { recordEmailDraftTool } from '../tools/crm/record-email-draft.js';
import { addContextTool, pushSignalTool } from '../tools/memory/add-context.js';
import {
  gmailSearchTool,
  gmailCreateDraftTool,
  gmailUpdateDraftTool,
  gmailListDraftsTool,
  gmailGetDraftTool,
  gmailDeleteDraftTool,
  calendarCreateEventTool,
} from '../tools/google/google-tools.js';
import {
  rssGetArticlesTool,
  rssSearchArticlesTool,
  rssCreateDigestTool,
} from '../tools/rss/rss-tools.js';
import { searchWebTool, findCompanyLinksTool } from '../tools/search/tavily.js';
import {
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeListNotebooksTool,
  knowledgeCreateNotebookTool,
  knowledgeAddSourceTool,
  knowledgeDeleteNotebookTool,
  knowledgeResearchStartTool,
} from '../tools/knowledge/knowledge-tools.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { workflowModels } from '../config/workflow-models.js';

const marketingInstructions = await loadPrompt('marketing/base');

const marketingTools = {
  // CRM (read + write context)
  searchLeadsTool,
  createLeadTool,
  updateStatusTool,
  updateLeadTool,
  addInteractionTool,
  recordEmailDraftTool,
  // Gmail drafts (NO gmailSendDraftTool – wymaga approval)
  gmailSearchTool,
  gmailCreateDraftTool,
  gmailUpdateDraftTool,
  gmailListDraftsTool,
  gmailGetDraftTool,
  gmailDeleteDraftTool,
  // Calendar
  calendarCreateEventTool,
  // RSS intelligence
  rssGetArticlesTool,
  rssSearchArticlesTool,
  rssCreateDigestTool,
  // Shared memory
  addContextTool,
  pushSignalTool,
  // Search (Tavily)
  searchWebTool,
  findCompanyLinksTool,
  // Knowledge (NotebookLM)
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeListNotebooksTool,
  knowledgeCreateNotebookTool,
  knowledgeAddSourceTool,
  knowledgeDeleteNotebookTool,
  knowledgeResearchStartTool,
};

function createMarketingAgent(id: string, name: string, model: string): Agent {
  return new Agent({
    id,
    name,
    instructions: marketingInstructions,
    model,
    memory: new Memory({
      options: {
        lastMessages: 15,
      },
    }),
    tools: marketingTools,
  });
}

export const marketingAgent = createMarketingAgent(
  'marketing-agent',
  'Marketing Agent',
  workflowModels.marketing.default,
);

export const weeklyContentResearchAgent = createMarketingAgent(
  'weekly-content-research-agent',
  'Weekly Content Research Agent',
  workflowModels.weeklyContent.research,
);

export const weeklyContentCopyAgent = createMarketingAgent(
  'weekly-content-copy-agent',
  'Weekly Content Copy Agent',
  workflowModels.weeklyContent.copyPl,
);

export const weeklyContentCopyRepairAgent = createMarketingAgent(
  'weekly-content-copy-repair-agent',
  'Weekly Content Copy Repair Agent',
  workflowModels.weeklyContent.copyRepair,
);

export const weeklyContentTranslationAgent = createMarketingAgent(
  'weekly-content-translation-agent',
  'Weekly Content Translation Agent',
  workflowModels.weeklyContent.translateEn,
);

export const weeklyContentJsonRepairAgent = createMarketingAgent(
  'weekly-content-json-repair-agent',
  'Weekly Content JSON Repair Agent',
  workflowModels.weeklyContent.jsonRepair,
);

export const producerHuntDiscoveryAgent = createMarketingAgent(
  'producer-hunt-discovery-agent',
  'Producer Hunt Discovery Agent',
  workflowModels.producerHunt.discovery,
);

export const producerHuntEnrichmentAgent = createMarketingAgent(
  'producer-hunt-enrichment-agent',
  'Producer Hunt Enrichment Agent',
  workflowModels.producerHunt.enrichment,
);

export const producerHuntEmailExtractionAgent = createMarketingAgent(
  'producer-hunt-email-extraction-agent',
  'Producer Hunt Email Extraction Agent',
  workflowModels.producerHunt.emailExtraction,
);

export const producerHuntDraftAgent = createMarketingAgent(
  'producer-hunt-draft-agent',
  'Producer Hunt Draft Agent',
  workflowModels.producerHunt.draftEmail,
);

export const producerHuntJsonRepairAgent = createMarketingAgent(
  'producer-hunt-json-repair-agent',
  'Producer Hunt JSON Repair Agent',
  workflowModels.producerHunt.jsonRepair,
);

export const producerHuntCloudFallbackAgent = createMarketingAgent(
  'producer-hunt-cloud-fallback-agent',
  'Producer Hunt Cloud Fallback Agent',
  workflowModels.producerHunt.cloudFallback,
);
