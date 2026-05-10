import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { TokenLimiterProcessor } from '@mastra/core/processors';
import { workflowModels } from '../config/workflow-models.js';
import { infrastructure, resolveModelId } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';
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
import { repoMapTool, repoStatsTool, repoReindexTool } from '../tools/dev/repo-map-tools.js';
import { codeSearchTool, codeEmbedStatsTool } from '../tools/dev/code-search-tools.js';

export const codingAgent: Agent = new Agent({
  id: 'coding-agent',
  name: 'Coding Agent',
  instructions: withAnthropicSystemCache(
    await loadPrompt('coding/base') + '\n\nRespond concisely and to the point, especially when asked about task status.',
  ),
  model: workflowModels.coding.default,
  workspace: codeWorkspace,
  defaultOptions: { maxSteps: 40 },
  defaultGenerateOptionsLegacy: { maxSteps: 40 },
  defaultStreamOptionsLegacy: { maxSteps: 40 },
  defaultNetworkOptions: { maxSteps: 40 },
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
    // Repo Indexing (Phase 5 — Structural Code Navigation)
    repoMapTool,
    repoStatsTool,
    repoReindexTool,
    // Semantic Code Search (Phase 5 — Embedding-based)
    codeSearchTool,
    codeEmbedStatsTool,
  },
  memory: new Memory({
    options: {
      lastMessages: 30,
      // Phase 1.1b — OM keeps context across 15+ subtask orchestrations
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread',  // Zmiana z 'resource' na 'thread' aby izolować kontekst między czatami
        temporalMarkers: true,
        observation: {
          threadTitle: true,
        },
      },
      generateTitle: true,
    },
  }),
  // Phase 5 — Context window protection (prevents overflow in long autonomous sessions)
  inputProcessors: [
    new TokenLimiterProcessor({
      limit: 120_000,  // Effective limit for Gemini 2.5 Flash (actual: 1M, but perf degrades after ~120K)
    }),
  ],
});
