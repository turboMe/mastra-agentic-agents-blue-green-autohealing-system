import { Agent } from '@mastra/core/agent';
import { workflowModels } from '../config/workflow-models.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { getCodeTaskArtifactTool, submitReviewTool } from '../tools/dev/code-task-artifacts.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';

export const codeReviewAgent: Agent = new Agent({
  id: 'code-review-agent',
  name: 'Code Review Agent',
  instructions: await loadPrompt('coding/review'),
  model: workflowModels.coding.review,
  workspace: codeWorkspace,
  tools: {
    getCodeTaskArtifactTool,
    submitReviewTool,
  },
});
