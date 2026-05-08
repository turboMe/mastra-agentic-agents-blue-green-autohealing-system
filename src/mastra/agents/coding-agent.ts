import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { workflowModels } from '../config/workflow-models.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import {
  createCodeTaskArtifactTool,
  getCodeTaskArtifactTool,
  updateCodeTaskArtifactTool,
  runTestCommandTool,
} from '../tools/dev/code-task-artifacts.js';
import {
  acceptAllChangesTool,
  acceptFileChangeTool,
  recordAfterChangeTool,
  recordBeforeChangeTool,
  rejectAllChangesTool,
  rejectFileChangeTool,
  writeFileTrackedTool,
} from '../tools/dev/code-change-ledger.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';

export const codingAgent: Agent = new Agent({
  id: 'coding-agent',
  name: 'Coding Agent',
  instructions: await loadPrompt('coding/base'),
  model: workflowModels.coding.default,
  workspace: codeWorkspace,
  tools: {
    createCodeTaskArtifactTool,
    updateCodeTaskArtifactTool,
    getCodeTaskArtifactTool,
    runTestCommandTool,
    recordBeforeChangeTool,
    recordAfterChangeTool,
    rejectFileChangeTool,
    rejectAllChangesTool,
    acceptFileChangeTool,
    acceptAllChangesTool,
    writeFileTrackedTool,
  },
  memory: new Memory({
    options: {
      lastMessages: 20,
    },
  }),
});
