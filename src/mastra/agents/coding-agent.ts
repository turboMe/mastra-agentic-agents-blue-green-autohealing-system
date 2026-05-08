import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { workflowModels } from '../config/workflow-models.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';

export const codingAgent: Agent = new Agent({
  id: 'coding-agent',
  name: 'Coding Agent',
  instructions: await loadPrompt('coding/base'),
  model: workflowModels.coding.default,
  workspace: codeWorkspace,
  memory: new Memory({
    options: {
      lastMessages: 20,
    },
  }),
});
