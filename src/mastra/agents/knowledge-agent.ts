/**
 * Knowledge Agent — Dedicated NotebookLM operations agent.
 *
 * Purpose:
 *   Encapsulates ALL NotebookLM interactions (create, source add, query,
 *   research, studio, cleanup) into a single reusable agent that can be
 *   called by meta-agent, marketing workflows, or any orchestrator.
 *
 * Tools:
 *   - 35 MCP tools from NotebookLM server (via mcpClient.listToolsets())
 *   - skill_search + skill_load for on-demand retrieval of NLM procedures
 *
 * Prompt Architecture (token-efficient):
 *   System prompt = ONLY the concise role definition (~66 lines):
 *     - Role, responsibilities, operational rules, known notebooks
 *     - Instruction to use skill_search for detailed procedures
 *   Full SKILL.md documentation is NOT in system prompt. Instead:
 *     - Split into 5 semantic skills in _skills/knowledge/
 *     - Indexed by SkillRegistry with embeddings
 *     - Agent retrieves relevant sections on-demand via skill_search → skill_load
 *
 * Design decisions:
 *   - Separate from search/browser agents — handles ONLY NLM operations
 *   - Token-efficient: ~66 line prompt + on-demand skills vs ~776 lines always
 *   - Model controlled via agentModels.knowledgeAgent in model-manifest.ts
 *   - Stateless (no Memory) — each call is a one-shot task
 */

import { Agent } from '@mastra/core/agent';
import { mcpClient } from '../mcp.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { agentModels, resolveModelId } from '../config/model-manifest.js';
import { skillSearchTool } from '../tools/system/skill-search.js';
import { skillLoadTool } from '../tools/system/skill-load.js';

const knowledgeInstructions = await loadPrompt('knowledge/notebooklm-agent');

// Get only NotebookLM MCP toolsets (exclude playwright, firecrawl)
const mcpToolsets = await mcpClient.listToolsets();
const nlmTools = mcpToolsets['notebooklm'] ?? {};

export const knowledgeAgent = new Agent({
  id: 'knowledge-agent',
  name: 'Knowledge Agent (NotebookLM)',
  instructions: knowledgeInstructions,
  model: resolveModelId(agentModels.knowledgeAgent),
  tools: {
    // 35 NotebookLM MCP tools (dynamic)
    ...nlmTools,
    // Skill retrieval (on-demand NLM procedures from _skills/knowledge/)
    skillSearchTool,
    skillLoadTool,
  },
});
