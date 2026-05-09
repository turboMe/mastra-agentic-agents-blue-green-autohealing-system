import { MCPClient } from '@mastra/mcp';

export const mcpClient = new MCPClient({
  servers: {
    'notebooklm': {
      command: 'uvx',
      args: ['notebooklm-mcp', 'server'],
    },

    // ── Browser Automation (Phase F2.1) ──────────────────────────────────
    // Playwright MCP — accessible tree mode (token-efficient, no screenshots)
    // Provides: navigate, click, fill, select, screenshot, evaluate, pdf
    'playwright': {
      command: 'npx',
      args: ['@playwright/mcp@latest'],
    },

    // ── Web Scraping (Phase F2.2) ────────────────────────────────────────
    // Firecrawl MCP — converts web pages to LLM-ready markdown
    // Provides: scrape, crawl, search, extract
    // Requires FIRECRAWL_API_KEY in .env
    ...(process.env.FIRECRAWL_API_KEY ? {
      'firecrawl': {
        command: 'npx',
        args: ['-y', 'firecrawl-mcp'],
        env: {
          FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
        },
      },
    } : {}),
  },
});
