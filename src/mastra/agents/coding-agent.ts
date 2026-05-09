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
import {
  initWorktreeTool,
  removeWorktreeTool,
  applyWorktreePatchTool,
} from '../tools/dev/code-worktree.js';
import {
  createExternalProjectTool,
  writeExternalProjectFileTool,
  runExternalProjectCommandTool,
  delegateToReviewerTool,
} from '../tools/dev/external-projects-tools.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';

export const codingAgent: Agent = new Agent({
  id: 'coding-agent',
  name: 'Coding Agent',
  instructions: await loadPrompt('coding/base') + '\n\nOdpowiadaj krótko i rzeczowo, zwłaszcza gdy użytkownik pyta o status zadań.',
  model: workflowModels.coding.default,
  workspace: codeWorkspace,
  defaultOptions: { maxSteps: 30 },
  defaultGenerateOptionsLegacy: { maxSteps: 30 },
  defaultStreamOptionsLegacy: { maxSteps: 30 },
  defaultNetworkOptions: { maxSteps: 30 },
  tools: {
    createCodeTaskArtifactTool,
    updateCodeTaskArtifactTool,
    getCodeTaskArtifactTool,
    runTestCommandTool,
    initWorktreeTool,
    removeWorktreeTool,
    applyWorktreePatchTool,
    recordBeforeChangeTool,
    recordAfterChangeTool,
    rejectFileChangeTool,
    rejectAllChangesTool,
    acceptFileChangeTool,
    acceptAllChangesTool,
    writeFileTrackedTool,
    createExternalProjectTool,
    writeExternalProjectFileTool,
    runExternalProjectCommandTool,
    delegateToReviewerTool,
  },
  memory: new Memory({
    options: {
      lastMessages: 20,
    },
  }),
});
