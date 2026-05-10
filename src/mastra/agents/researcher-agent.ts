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

// Defensywnie: nie pozwól żeby padły MCP serwery (np. notebooklm/Chrome) zablokowały start agenta.
// Researcher i tak ma użyteczny baseline (Tavily + skill tools); playwright/firecrawl to bonus.
let playwrightTools: Record<string, any> = {};
let firecrawlTools: Record<string, any> = {};
try {
  const mcpToolsets = await mcpClient.listToolsets();
  playwrightTools = mcpToolsets['playwright'] ?? {};
  firecrawlTools = mcpToolsets['firecrawl'] ?? {};
} catch (err) {
  console.warn('[researcher-agent] MCP listToolsets failed — startuję bez playwright/firecrawl:', (err as Error).message);
}

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
