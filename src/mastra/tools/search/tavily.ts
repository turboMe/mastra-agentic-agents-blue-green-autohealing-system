/**
 * Tavily web search tools.
 * Ported from: packages/search/src/index.ts (jarvis).
 * Used by: producer-hunt enrichment, marketing research, knowledge-plan 'search' mode.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// Internal service (shared across tools)
// ────────────────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

async function tavilySearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY nie jest ustawiony w .env');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: maxResults }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Tavily API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { results: any[] };
  return data.results.map(r => ({ title: r.title, url: r.url, content: r.content, score: r.score }));
}

const DIRECTORIES = [
  'panoramafirm.pl', 'aleo.com', 'owg.pl', 'biznesfinder.pl', 'cylex.pl',
  'infoveriti.pl', 'krs-online.com.pl', 'money.pl', 'oferteo.pl', 'yellowpages',
  'targeo.pl', 'pkt.pl', 'msp.money.pl', 'rejestr.io',
];

// ────────────────────────────────────────────────────────────────────────────
// searchWebTool
// ────────────────────────────────────────────────────────────────────────────
export const searchWebTool = createTool({
  id: 'search.web',
  description: 'Wyszukuje w internecie przez Tavily API. Używaj do aktualnych informacji (wiadomości, trendy, dane rynkowe) lub gdy NotebookLM nie ma odpowiedzi.',
  inputSchema: z.object({
    query: z.string().describe('Zapytanie do wyszukiwarki (po polsku lub angielsku)'),
    maxResults: z.number().optional().default(5).describe('Maksymalna liczba wyników (1-10)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    results: z.array(z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      score: z.number(),
    })),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const results = await tavilySearch(context.query, Math.min(context.maxResults ?? 5, 10));
      return { success: true, count: results.length, results };
    } catch (error) {
      return { success: false, count: 0, results: [], error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// findCompanyLinksTool
// ────────────────────────────────────────────────────────────────────────────
export const findCompanyLinksTool = createTool({
  id: 'search.find_company_links',
  description: 'Wyszukuje oficjalną stronę WWW, LinkedIn i Facebook firmy. Przydatne w producer-hunt do enrichmentu leadów przed draftowaniem emaila.',
  inputSchema: z.object({
    companyName: z.string().describe('Nazwa firmy do wyszukania'),
    region: z.string().optional().default('').describe('Region (np. "Kujawsko-Pomorskie") — poprawia trafność wyników'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    website: z.string().optional(),
    linkedIn: z.string().optional(),
    facebook: z.string().optional(),
    searchContext: z.string().optional().describe('Surowe wyniki (tytuły + snippety) do użycia jako kontekst LLM'),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const query = `oficjalna strona www facebook linkedin ${context.companyName} ${context.region ?? ''}`.trim();
      const results = await tavilySearch(query, 10);

      const info: { website?: string; linkedIn?: string; facebook?: string; searchContext?: string } = {
        searchContext: results.map(r => `[${r.title}](${r.url}): ${r.content.slice(0, 200)}`).join('\n\n'),
      };

      for (const res of results) {
        const url = res.url.toLowerCase();
        if (!info.linkedIn && url.includes('linkedin.com/company')) { info.linkedIn = res.url; continue; }
        if (!info.facebook && url.includes('facebook.com') && !url.includes('/groups/') && !url.includes('/posts/')) {
          info.facebook = res.url; continue;
        }
        const isDir = DIRECTORIES.some(d => url.includes(d));
        const isSocial = url.includes('instagram.com') || url.includes('twitter.com') || url.includes('youtube.com');
        if (!info.website && !isDir && !isSocial) {
          const words = context.companyName.toLowerCase().split(' ').filter(w => w.length > 3);
          const match = words.filter(w => url.includes(w) || res.title.toLowerCase().includes(w)).length;
          if (match > 0 || res.score > 0.8) info.website = res.url;
        }
      }

      if (!info.website && results.length > 0) {
        const first = results.find(r => !r.url.includes('facebook.com') && !r.url.includes('linkedin.com'));
        if (first) info.website = first.url;
      }

      return { success: true, ...info };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
