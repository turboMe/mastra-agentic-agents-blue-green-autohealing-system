import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { workflowModels } from '../config/workflow-models.js';
import { infrastructure, resolveModelId } from '../config/model-manifest.js';
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
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { skillSearchTool } from '../tools/system/skill-search.js';
import { skillLoadTool } from '../tools/system/skill-load.js';
import { skillReportTool } from '../tools/system/skill-report.js';

export const codingAgent: Agent = new Agent({
  id: 'coding-agent',
  name: 'Coding Agent',
  instructions: await loadPrompt('coding/base') + '\n\nRespond concisely and to the point, especially when asked about task status.',
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
    // System knowledge (Phase 1.4)
    memoryRecallTool,
    memoryWriteTool,
    // Skill Registry (Phase 2.3)
    skillSearchTool,
    skillLoadTool,
    skillReportTool,
  },
  memory: new Memory({
    options: {
      lastMessages: 30,
      // Phase 1.1b — OM keeps context across 15+ subtask orchestrations
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        temporalMarkers: true,
        observation: {
          threadTitle: true,
        },
      },
      generateTitle: true,
    },
  }),
});
