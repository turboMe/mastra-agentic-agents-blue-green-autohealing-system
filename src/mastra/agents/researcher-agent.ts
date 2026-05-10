/**
 * Researcher Agent — Standalone web research agent (PSEV strategy).
 *
 * Purpose:
 *   Autonomous deep web research using the Plan-Search-Extract-Verify loop.
 *   Can be called directly from the UI or by orchestrating agents.
 *
 * Tools:
 *   - searchWebTool / findCompanyLinksTool — Tavily web search
 *   - Playwright MCP toolset — browser navigation and scraping
 *   - skillSearchTool / skillLoadTool — on-demand research procedures
 *
 * Prompt:
 *   Loaded from prompts/shared/subagent-researcher.md
 */

import { Agent } from '@mastra/core/agent';
import { mcpClient } from '../mcp.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { agentModels, resolveModelId } from '../config/model-manifest.js';
import { searchWebTool, findCompanyLinksTool } from '../tools/search/tavily.js';
import { skillSearchTool } from '../tools/system/skill-search.js';
import { skillLoadTool } from '../tools/system/skill-load.js';

const researcherInstructions = await loadPrompt('shared/subagent-researcher');

const mcpToolsets = await mcpClient.listToolsets();
const playwrightTools = mcpToolsets['playwright'] ?? {};
const firecrawlTools = mcpToolsets['firecrawl'] ?? {};

export const researcherAgent = new Agent({
  id: 'researcher-agent',
  name: 'Researcher Agent (PSEV)',
  instructions: researcherInstructions,
  model: resolveModelId(agentModels.researcherAgent),
  tools: {
    searchWebTool,
    findCompanyLinksTool,
    skillSearchTool,
    skillLoadTool,
    ...playwrightTools,
    ...firecrawlTools,
  },
});
