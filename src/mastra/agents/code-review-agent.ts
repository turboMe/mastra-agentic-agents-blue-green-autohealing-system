import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { workflowModels } from '../config/workflow-models.js';
import { infrastructure, resolveModelId } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { getCodeTaskArtifactTool, submitReviewTool } from '../tools/dev/code-task-artifacts.js';
import { listWorktreeFilesTool, readWorktreeFileTool, worktreeDiffTool } from '../tools/dev/code-worktree.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
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
    listWorktreeFilesTool,
    readWorktreeFileTool,
    worktreeDiffTool,
    system_memory_recall: memoryRecallTool,
    system_memory_write_observation: memoryWriteTool,
  },
  memory: new Memory({
    options: {
      lastMessages: 30,
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread',
        temporalMarkers: true,
        observation: {
          threadTitle: true,
        },
      },
      generateTitle: true,
    },
  }),
});
