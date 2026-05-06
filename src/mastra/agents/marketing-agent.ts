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

export const marketingAgent = new Agent({
  id: 'marketing-agent',
  name: 'Marketing Agent',
  instructions: await loadPrompt('marketing/base'),
  model: 'ollama/local/gemma4:26b',
  memory: new Memory({
    options: {
      lastMessages: 15,
    },
  }),
  tools: {
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
  },
});
