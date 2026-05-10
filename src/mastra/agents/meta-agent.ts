import { Agent } from '@mastra/core/agent';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
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
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { currentTimeTool } from '../tools/system/current-time.js';
import { skillSearchTool } from '../tools/system/skill-search.js';
import { metaExecuteCommandTool } from '../tools/system/meta-execute-command.js';
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
  sheetsCreateSpreadsheetTool,
  sheetsReadRangeTool,
  sheetsWriteRangeTool,
  sheetsAppendRowsTool,
  sheetsGetMetadataTool,
  slidesCreatePresentationTool,
  slidesGetMetadataTool,
  slidesAddSlideTool,
  slidesReplaceTextTool,
  slidesAddTextBoxTool,
  slidesDeleteSlideTool,
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
import { competitorAnalysisTool } from '../tools/business/competitor-analysis.js';
import { mongoQueryTool, mongoWriteTool } from '../tools/system/mongo-tools.js';
import { agentPerformanceReportTool } from '../tools/system/agent-performance-report.js';
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
  model: resolveModelId(agentModels.metaAgent),
  defaultOptions: { maxSteps: 40 },
  defaultGenerateOptionsLegacy: { maxSteps: 40 },
  defaultStreamOptionsLegacy: { maxSteps: 40 },
  defaultNetworkOptions: { maxSteps: 40 },

  memory: new Memory({
    options: {
      // 30 messages — enough to see full retry loops and parallel call traces in context
      lastMessages: 30,
      // Phase 1.1 — Observational Memory: compresses long conversations into structured observations
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'resource',  // tolerate requests bez threadId (Mastra 1.32+ rzuca twardo dla scope:'thread')
        temporalMarkers: true,
        observation: {
          threadTitle: true, // OM auto-generates descriptive thread titles
        },
      },
      // Working Memory — persistent scratchpad surviving across sessions
      workingMemory: {
        enabled: true,
        template: `# Meta Agent Working Memory

## User Preferences
- **Communication style**:
- **Language**: Polish
- **Decision authority**: high autonomy

## Active Project Context
- **Current phase**:
- **Key decisions**:
- **Blockers**:

## Learned Patterns
- **Effective strategies**:
- **Known pitfalls**:
`,
      },
      // Auto-generate thread titles for Studio readability
      generateTitle: true,
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
    // System knowledge (Phase 1.4)
    memoryRecallTool,
    memoryWriteTool,
    // Skill discovery (Phase 2.3) — find skills, delegate execution to codingAgent
    skillSearchTool,
    // Utility
    currentTimeTool,
    // Shell execution (workaround dla Mastra v1.31/1.32 bug z workspace sandbox)
    metaExecuteCommandTool,
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
        // Google Sheets (Faza 6.1)
        sheetsCreateSpreadsheetTool,
        sheetsReadRangeTool,
        sheetsWriteRangeTool,
        sheetsAppendRowsTool,
        sheetsGetMetadataTool,
        // Google Slides (Faza 6.1)
        slidesCreatePresentationTool,
        slidesGetMetadataTool,
        slidesAddSlideTool,
        slidesReplaceTextTool,
        slidesAddTextBoxTool,
        slidesDeleteSlideTool,
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
        // Business intelligence
        competitorAnalysisTool,
        // Database (readonly-first policy — writes require confirm: true)
        mongoQueryTool,
        mongoWriteTool,
        // Agent performance reporting (Faza 7.6)
        agentPerformanceReportTool,
      },
      search: { topK: 12, minScore: 0.3 },
      ttl: 3_600_000,
    }),
  ],
});
