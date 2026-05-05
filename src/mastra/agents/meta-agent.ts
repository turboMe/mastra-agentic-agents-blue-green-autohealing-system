import { Agent } from '@mastra/core/agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { createLeadTool } from '../tools/crm/create-lead';
import { updateStatusTool } from '../tools/crm/update-status';
import { searchLeadsTool } from '../tools/crm/search-leads';
import { addInteractionTool } from '../tools/crm/add-interaction';
import { updateLeadTool } from '../tools/crm/update-lead';
import { recordEmailDraftTool } from '../tools/crm/record-email-draft';
import { addContextTool, listContextTool, pushSignalTool } from '../tools/memory/add-context';
import { delegateTaskTool } from '../tools/system/delegate-task';
import { triggerWorkflowTool } from '../tools/system/trigger-workflow';
import { requestApprovalTool } from '../tools/system/request-approval';
import { requestApprovalTool } from '../tools/system/request-approval';

import {
  n8nTriggerWebhookTool,
  n8nHealthTool,
  n8nListWorkflowsTool,
  n8nGetWorkflowTool,
  n8nUpdateWorkflowTool,
  n8nActivateWorkflowTool,
  n8nDeactivateWorkflowTool,
} from '../tools/n8n/n8n-tools';
import {
  gmailSearchTool,
  gmailCreateDraftTool,
  gmailUpdateDraftTool,
  gmailListDraftsTool,
  gmailGetDraftTool,
  gmailSendDraftTool,
  gmailDeleteDraftTool,
  calendarCreateEventTool,
  calendarFindEventTool,
  calendarUpdateEventTool,
  calendarDeleteEventTool,
} from '../tools/google/google-tools';
import {
  chefStartProjectTool,
  chefUpdateProfileTool,
  chefGenerateMenuTool,
  chefDraftRecipeTool,
  chefGetProjectTool,
  chefListProjectsTool,
  chefSaveMenuTool,
  chefGetMenuTool,
  chefIterateMenuTool,
  chefGetRecipeTool,
  chefQueryKnowledgeTool,
  chefSuggestPairingTool,
  chefCheckSeasonalTool,
  chefAddNoteTool,
  chefSearchNotesTool,
  chefExportMenuTool,
} from '../tools/chef/chef-tools';
import {
  rssGetArticlesTool,
  rssGetDigestsTool,
  rssSearchArticlesTool,
  rssCreateDigestTool,
  rssListSourcesTool,
} from '../tools/rss/rss-tools';
import {
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeListNotebooksTool,
  knowledgeCreateNotebookTool,
  knowledgeAddSourceTool,
  knowledgeDeleteNotebookTool,
} from '../tools/knowledge/knowledge-tools';
import { searchWebTool, findCompanyLinksTool } from '../tools/search/tavily';
import { loadPrompt, combinePrompts } from '../lib/prompt-loader';
import { sharedMemoryOutputProcessor } from '../processors/shared-memory-output';

async function buildInstructions(): Promise<string> {
  // base v2 zawiera mapę sub-agentów, decision tree i reguły parallel tool calling.
  // response v1 dokleja format JSON {thought, reply, suggestedJobs} dla workflow runtime.
  return await combinePrompts('meta/base', 'meta/response');
}

export const metaAgent: Agent = new Agent({
  id: 'meta-agent',
  name: 'Meta Agent',
  instructions: await buildInstructions(),
  model: 'google/gemini-2.5-pro',
  memory: new Memory({
    options: {
      lastMessages: 20
    },
  }),
  // Automatically persist key decisions to shared_memory after each response
  outputProcessors: [sharedMemoryOutputProcessor],
  // Supervisor essentials — always loaded into context
  tools: {
    delegateTaskTool,
    triggerWorkflowTool,
    requestApprovalTool,
    searchLeadsTool,
    addContextTool,
    listContextTool,
    pushSignalTool,
  },
  // Searchable tool pool (~50 tools) — agent uses search_tools/load_tool meta-tools
  // to discover and load on demand. Drastically reduces prompt context per turn.
  inputProcessors: [
    new ToolSearchProcessor({
      tools: {
        // CRM (write paths)
        createLeadTool,
        updateStatusTool,
        addInteractionTool,
        updateLeadTool,
        recordEmailDraftTool,
        // Terminal / sandbox tools inherited from Workspace

        // n8n automation
        n8nTriggerWebhookTool,
        n8nHealthTool,
        n8nListWorkflowsTool,
        n8nGetWorkflowTool,
        n8nUpdateWorkflowTool,
        n8nActivateWorkflowTool,
        n8nDeactivateWorkflowTool,
        // Gmail
        gmailSearchTool,
        gmailCreateDraftTool,
        gmailUpdateDraftTool,
        gmailListDraftsTool,
        gmailGetDraftTool,
        gmailSendDraftTool,
        gmailDeleteDraftTool,
        // Calendar
        calendarCreateEventTool,
        calendarFindEventTool,
        calendarUpdateEventTool,
        calendarDeleteEventTool,
        // Chef / menu domain
        chefStartProjectTool,
        chefUpdateProfileTool,
        chefGenerateMenuTool,
        chefDraftRecipeTool,
        chefGetProjectTool,
        chefListProjectsTool,
        chefSaveMenuTool,
        chefGetMenuTool,
        chefIterateMenuTool,
        chefGetRecipeTool,
        chefQueryKnowledgeTool,
        chefSuggestPairingTool,
        chefCheckSeasonalTool,
        chefAddNoteTool,
        chefSearchNotesTool,
        chefExportMenuTool,
        // RSS intelligence
        rssGetArticlesTool,
        rssGetDigestsTool,
        rssSearchArticlesTool,
        rssCreateDigestTool,
        rssListSourcesTool,
        // NotebookLM knowledge (replaces MCP)
        knowledgeQueryTool,
        knowledgeQueryMultiTool,
        knowledgeListNotebooksTool,
        knowledgeCreateNotebookTool,
        knowledgeAddSourceTool,
        knowledgeDeleteNotebookTool,
        // Web search (Tavily)
        searchWebTool,
        findCompanyLinksTool,
      },
      search: { topK: 12, minScore: 0.3 },
      ttl: 3_600_000,
    }),
  ],
});
