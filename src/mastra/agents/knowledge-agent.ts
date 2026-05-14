/**
 * Knowledge Agent — Dedicated NotebookLM operations agent.
 *
 * Purpose:
 *   Encapsulates ALL NotebookLM interactions (create, source add, query,
 *   research, studio, cleanup) into a single reusable agent that can be
 *   called by meta-agent, marketing workflows, or any orchestrator.
 *
 * Tools:
 *   - Core MCP tools from NotebookLM server (always visible)
 *   - Remaining NotebookLM MCP tools via ToolSearchProcessor
 *   - skill_search + skill_load for on-demand retrieval of NLM procedures
 *
 * Prompt Architecture (token-efficient):
 *   System prompt = ONLY the concise role definition (~66 lines):
 *     - Role, responsibilities, operational rules, known notebooks
 *     - Instruction to use skill_search for detailed procedures
 *   Full SKILL.md documentation is NOT in system prompt. Instead:
 *     - Split into semantic skills in _skills/knowledge/
 *     - Indexed by SkillRegistry with embeddings
 *     - Agent retrieves relevant sections on-demand via skill_search → skill_load
 *
 * Design decisions:
 *   - Separate from search/browser agents — handles ONLY NLM operations
 *   - Token-efficient: ~66 line prompt + on-demand skills vs ~776 lines always
 *   - Model controlled via agentModels.knowledgeAgent in model-manifest.ts
 *   - Has Memory — tracks notebook aliases, active research, source state,
 *     and operational NotebookLM lessons by thread.
 */

import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { TokenLimiterProcessor, ToolSearchProcessor } from '@mastra/core/processors';
import { mcpClient } from '../mcp.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { skillSearchTool } from '../tools/system/skill-search.js';
import { skillLoadTool } from '../tools/system/skill-load.js';
import { skillReportTool } from '../tools/system/skill-report.js';
import { knowledgePendingUpdatesProcessor } from '../processors/pending-updates.js';

const knowledgeInstructions = withAnthropicSystemCache(await loadPrompt('knowledge/notebooklm-agent'));

// Get only NotebookLM MCP toolsets (exclude playwright, firecrawl)
const mcpToolsets = await mcpClient.listToolsets();
const nlmTools = (mcpToolsets['notebooklm'] ?? {}) as Record<string, any>;
const alwaysVisibleNlmToolNames = ['server_info', 'refresh_auth', 'notebook_list'];
const alwaysVisibleNlmTools = pickTools(nlmTools, alwaysVisibleNlmToolNames);
const discoverableNlmTools = aliasToolIdsToLocalNames(omitTools(nlmTools, alwaysVisibleNlmToolNames));

export const knowledgeAgent = new Agent({
  id: 'knowledge-agent',
  name: 'Knowledge Agent (NotebookLM)',
  instructions: knowledgeInstructions,
  model: resolveModelId(agentModels.knowledgeAgent),
  maxRetries: 2,
  defaultOptions: { maxSteps: 40 },
  defaultGenerateOptionsLegacy: { maxSteps: 40 },
  defaultStreamOptionsLegacy: { maxSteps: 40 },
  defaultNetworkOptions: { maxSteps: 40 },
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
      workingMemory: {
        enabled: true,
        template: `# Knowledge Agent Working Memory

## NotebookLM Runtime
- Active account:
- Last MCP/auth status:
- Known MCP limitations:

## Notebook Aliases
- alias -> notebookId -> title -> purpose

## Active Research
- taskId:
- notebookId:
- status:
- next check:

## Source State
- recently added sources:
- indexing status:
- source failures:

## Operational Lessons
- reliable tool sequences:
- known failure modes:
- user preferences:
`,
      },
      generateTitle: {
        model: resolveModelId('gemma4-e4b'),
        instructions:
          'Generate a concise thread title for a NotebookLM task. Return only the title text, max 60 characters.',
      },
    },
  }),
  tools: {
    // Always-visible NotebookLM MCP tools.
    ...alwaysVisibleNlmTools,
    // Stable snake_case aliases. Mastra exposes tool calls by the object key,
    // so camelCase keys here make the prompt's `skill_search` contract fail.
    skill_search: skillSearchTool,
    skill_load: skillLoadTool,
    skill_report_result: skillReportTool,
    system_memory_recall: memoryRecallTool,
    system_memory_write_observation: memoryWriteTool,
  },
  inputProcessors: [
    knowledgePendingUpdatesProcessor,
    new ToolSearchProcessor({
      tools: discoverableNlmTools,
      search: { topK: 8, minScore: 0.2 },
      ttl: 3_600_000,
    }),
    new TokenLimiterProcessor({
      limit: 120_000,
    }),
  ],
});

function pickTools<T extends Record<string, any>>(tools: T, names: string[]): Record<string, any> {
  return Object.fromEntries(
    names
      .map((name) => [name, tools[name]])
      .filter(([, tool]) => Boolean(tool)),
  );
}

function omitTools<T extends Record<string, any>>(tools: T, omittedNames: string[]): Record<string, any> {
  const omitted = new Set(omittedNames);
  return Object.fromEntries(
    Object.entries(tools).filter(([name, tool]) => !omitted.has(name) && Boolean(tool)),
  );
}

function aliasToolIdsToLocalNames<T extends Record<string, any>>(tools: T): Record<string, any> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      tool && typeof tool === 'object'
        ? { ...tool, id: name }
        : tool,
    ]),
  );
}
