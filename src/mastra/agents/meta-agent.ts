import { Agent } from '@mastra/core/agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { createLeadTool } from '../tools/crm/create-lead.js';
import { updateStatusTool } from '../tools/crm/update-status.js';
import { searchLeadsTool } from '../tools/crm/search-leads.js';
import { addInteractionTool } from '../tools/crm/add-interaction.js';
import { updateLeadTool } from '../tools/crm/update-lead.js';
import { recordEmailDraftTool } from '../tools/crm/record-email-draft.js';
import { addContextTool, listContextTool, pushSignalTool } from '../tools/memory/add-context.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { triggerWorkflowTool } from '../tools/system/trigger-workflow.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { recallWorkerLessonsTool } from '../tools/system/recall-worker-lessons.js';
import {
  n8nTriggerWebhookTool,
  n8nHealthTool,
  n8nListWorkflowsTool,
  n8nGetWorkflowTool,
} from '../tools/n8n/n8n-tools.js';
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
} from '../tools/google/google-tools.js';
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
} from '../tools/chef/chef-tools.js';
import {
  rssGetArticlesTool,
  rssGetDigestsTool,
  rssSearchArticlesTool,
  rssCreateDigestTool,
  rssListSourcesTool,
} from '../tools/rss/rss-tools.js';
import {
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeListNotebooksTool,
  knowledgeCreateNotebookTool,
  knowledgeAddSourceTool,
  knowledgeDeleteNotebookTool,
} from '../tools/knowledge/knowledge-tools.js';
import { searchWebTool, findCompanyLinksTool } from '../tools/search/tavily.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { sharedMemoryOutputProcessor } from '../processors/shared-memory-output.js';

async function buildInstructions(): Promise<string> {
  // base v3: full orchestrator rules — parallel calling, worker briefs, retry loop, creativity.
  // response.md (JSON wrapper) removed — Mastra Studio renders plain markdown directly.
  return await combinePrompts('meta/base');
}

export const metaAgent: Agent = new Agent({
  id: 'meta-agent',
  name: 'Meta Agent',
  instructions: await buildInstructions(),
  model: 'google/gemini-2.5-pro',

  memory: new Memory({
    options: {
      // 30 messages — enough to see full retry loops and parallel call traces in context
      lastMessages: 30,
    },
  }),

  // Persist key decisions to shared_memory after each response
  outputProcessors: [sharedMemoryOutputProcessor],

  // ── Supervisor essentials — always in the prompt context ──────────────────
  // Keep this list lean: only tools meta needs in EVERY turn.
  // Everything else lives in the ToolSearchProcessor pool below.
  tools: {
    // Orchestration
    delegateTaskTool,
    triggerWorkflowTool,
    requestApprovalTool,
    // Ad-hoc workers (Etap 1 — blank local model executors)
    runWorkerTool,
    recallWorkerLessonsTool,
    // Fast CRM lookup (read-only, used constantly)
    searchLeadsTool,
    // Shared memory & signals
    addContextTool,
    listContextTool,
    pushSignalTool,
  },

  // ── Discoverable tool pool (~50 tools via semantic search) ────────────────
  // Agent calls search_tools(query) → ToolSearchProcessor returns top matches.
  // Drastically reduces prompt size per turn while keeping full tool coverage.
  inputProcessors: [
    new ToolSearchProcessor({
      tools: {
        // CRM (write paths — discovered on demand)
        createLeadTool,
        updateStatusTool,
        addInteractionTool,
        updateLeadTool,
        recordEmailDraftTool,
        // n8n automation
        n8nTriggerWebhookTool,
        n8nHealthTool,
        n8nListWorkflowsTool,
        n8nGetWorkflowTool,
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
        // NotebookLM knowledge
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
