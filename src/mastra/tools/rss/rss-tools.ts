import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getRssDb } from '../../lib/mongo';

export class RssService {
  async getLatestArticles(limit: number = 5): Promise<any[]> {
    const db = await getRssDb();
    return db.collection('rss_articles').find({}).sort({ publishedAt: -1, pubDate: -1 }).limit(limit).toArray();
  }

  async getLatestDigests(limit: number = 3): Promise<any[]> {
    const db = await getRssDb();
    return db.collection('digests').find({}).sort({ _id: -1 }).limit(limit).toArray();
  }

  async searchArticles(query: string, limit: number = 5): Promise<any[]> {
    const db = await getRssDb();
    return db.collection('rss_articles').find({
      $or: [
        { title: { $regex: query, $options: 'i' } },
        { description: { $regex: query, $options: 'i' } },
        { summary_ai: { $regex: query, $options: 'i' } },
      ]
    }).sort({ publishedAt: -1, pubDate: -1 }).limit(limit).toArray();
  }

  async listSources(): Promise<any[]> {
    const db = await getRssDb();
    return db.collection('rss_sources').find({}).toArray();
  }

  async addSource(url: string, name?: string): Promise<void> {
    const db = await getRssDb();
    await db.collection('rss_sources').updateOne(
      { url },
      { $set: { url, name: name || url, last_fetch: null, active: true } },
      { upsert: true }
    );
  }

  async removeSource(url: string): Promise<void> {
    const db = await getRssDb();
    await db.collection('rss_sources').deleteOne({ url });
  }
  
  async createDigest(subject: string, body: string): Promise<string> {
    const db = await getRssDb();
    const result = await db.collection('digests').insertOne({
        subject,
        body,
        generated_at: new Date().toISOString()
    });
    return result.insertedId.toString();
  }
}

// -- MASTRA TOOLS --

export const rssGetArticlesTool = createTool({
  id: 'rss_get_articles',
  description: 'Pobiera najnowsze artykuły z bazy RSS.',
  inputSchema: z.object({
    limit: z.number().optional().default(5)
  }),
  execute: async (context) => {
    try {
      const rss = new RssService();
      const articles = await rss.getLatestArticles(context.limit);
      return { success: true, articles };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
});

export const rssGetDigestsTool = createTool({
  id: 'rss_get_digests',
  description: 'Pobiera najnowsze podsumowania (digesty) artykułów RSS.',
  inputSchema: z.object({
    limit: z.number().optional().default(3)
  }),
  execute: async (context) => {
    try {
      const rss = new RssService();
      const digests = await rss.getLatestDigests(context.limit);
      return { success: true, digests };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
});

export const rssSearchArticlesTool = createTool({
  id: 'rss_search_articles',
  description: 'Wyszukuje artykuły RSS po słowach kluczowych w tytule lub opisie.',
  inputSchema: z.object({
    query: z.string(),
    limit: z.number().optional().default(5)
  }),
  execute: async (context) => {
    try {
      const rss = new RssService();
      const articles = await rss.searchArticles(context.query, context.limit);
      return { success: true, articles };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
});

export const rssCreateDigestTool = createTool({
  id: 'rss_create_digest',
  description: 'Tworzy i zapisuje podsumowanie (digest) z informacji zebranych przez agenta.',
  inputSchema: z.object({
    subject: z.string().describe('Temat podsumowania (np. AI News z ostatniego tygodnia)'),
    body: z.string().describe('Główna treść zredagowana przez LLM (najlepiej Markdown)')
  }),
  execute: async (context) => {
    try {
      const rss = new RssService();
      const digestId = await rss.createDigest(context.subject, context.body);
      return { success: true, digestId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
});

export const rssListSourcesTool = createTool({
  id: 'rss_list_sources',
  description: 'Wyświetla listę źródeł (URL) nasłuchiwanych przez pobieracza RSS.',
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const rss = new RssService();
      const sources = await rss.listSources();
      return { success: true, sources };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
});
