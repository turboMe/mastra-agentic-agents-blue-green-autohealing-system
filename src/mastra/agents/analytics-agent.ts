import { Agent } from '@mastra/core/agent';
import { agentModels, resolveModelId } from '../config/model-manifest.js';
import { Memory } from '@mastra/memory';
import { pushSignalTool, addContextTool, listContextTool } from '../tools/memory/add-context.js';
import {
  n8nHealthTool,
  n8nListWorkflowsTool,
  n8nGetWorkflowTool,
} from '../tools/n8n/n8n-tools.js';
import { agentPerformanceReportTool } from '../tools/system/agent-performance-report.js';
import { loadPrompt } from '../lib/prompt-loader.js';

export const analyticsAgent = new Agent({
  id: 'analytics-agent',
  name: 'Analytics Agent',
  instructions: await loadPrompt('analytics/base'),
  model: resolveModelId(agentModels.analyticsAgent),

  memory: new Memory({
    options: {
      lastMessages: 10,
    },
  }),
  tools: {
    // n8n monitoring
    n8nHealthTool,
    n8nListWorkflowsTool,
    n8nGetWorkflowTool,
    // Shared memory (read + write signals)
    listContextTool,
    addContextTool,
    pushSignalTool,
    // Agent performance report (Faza 7.6)
    agentPerformanceReportTool,
  },
});
