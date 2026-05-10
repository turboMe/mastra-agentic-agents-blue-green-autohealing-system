import { MCPClient } from '@mastra/mcp';

export const mcpClient = new MCPClient({
  // Default 60s jest za krótki dla fresh uvx (dociąga undetected-chromedriver +
  // setuptools<70 + chromedriver matching Chrome version przy pierwszym uruchomieniu).
  // 180s daje zapas; po ucache-owaniu uvx uruchomienia są szybkie.
  timeout: 180000,
  servers: {
    // ── NotebookLM MCP — SIDECAR ───────────────────────────────────────
    // Działa jako daemon w tle (systemd user service: notebooklm-mcp.service)
    // Łączymy się z nim po szybkim SSE, aby nie blokować startu Mastry.
    'notebooklm': {
      url: new URL('http://127.0.0.1:8765/sse'),
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
