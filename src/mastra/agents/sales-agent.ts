import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { updateStatusTool } from '../tools/crm/update-status.js';
import { addInteractionTool } from '../tools/crm/add-interaction.js';
import { searchLeadsTool } from '../tools/crm/search-leads.js';
import { addContextTool } from '../tools/memory/add-context.js';
import {
  gmailCreateDraftTool,
  gmailListDraftsTool,
  gmailGetDraftTool,
  calendarCreateEventTool,
  calendarFindEventTool,
} from '../tools/google/google-tools.js';
import { loadPrompt } from '../lib/prompt-loader.js';

export const salesAgent = new Agent({
  id: 'sales-agent',
  name: 'Sales Agent',
  instructions: await loadPrompt('sales/base'),
  model: 'google/gemini-2.5-flash',
  memory: new Memory({
    options: {
      lastMessages: 15,
    },
  }),
  tools: {
    searchLeadsTool,
    updateStatusTool,
    addInteractionTool,
    addContextTool,
    gmailCreateDraftTool,
    gmailListDraftsTool,
    gmailGetDraftTool,
    calendarCreateEventTool,
    calendarFindEventTool,
  },
});
