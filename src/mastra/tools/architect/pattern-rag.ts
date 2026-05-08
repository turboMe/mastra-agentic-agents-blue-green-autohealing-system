/**
 * Pattern RAG: embedduje katalog patternów do MongoDB i robi semantic search.
 *
 * Tools:
 * - architect.sync_patterns — jednorazowo lub po edycji catalog.ts. Zapisuje
 *   do `automation_patterns` z embeddingami (Google text-embedding-004).
 * - architect.match_pattern — szuka top-K patternów dla zadanego AutomationSpec.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import {
  generateEmbedding,
  cosineSimilarity,
} from '../../lib/embedder.js';
import {
  PATTERN_CATALOG,
  type StoredAutomationPattern,
} from './pattern-catalog.js';

const COLLECTION = 'automation_patterns';
const MIN_SIMILARITY = 0.35;

export const syncPatternsTool = createTool({
  id: 'architect.sync_patterns',
  description:
    'Synchronizuje katalog patternów do MongoDB z embeddingami semantycznymi. Wywołaj po edycji pattern-catalog.ts lub przy pierwszym uruchomieniu.',
  inputSchema: z.object({
    force: z
      .boolean()
      .default(false)
      .describe('Wymuś re-embedding wszystkich patternów (nawet nieprzeczytanych)'),
  }),
  outputSchema: z.object({
    synced: z.number(),
    embedded: z.number(),
    skipped: z.number(),
  }),
  execute: async (context) => {
    const force = context.force ?? false;
    const db = await getDb();
    const col = db.collection<StoredAutomationPattern>(COLLECTION);

    let synced = 0;
    let embedded = 0;
    let skipped = 0;

    for (const p of PATTERN_CATALOG) {
      const existing = await col.findOne({ id: p.id });
      const descChanged = !!existing && existing.description !== p.description;
      const needsEmbedding = force || !existing || descChanged || !existing.embedding;

      let embedding = existing?.embedding;
      if (needsEmbedding) {
        try {
          const text = `${p.name}: ${p.description} (Intents: ${p.supportedIntents.join(', ')})`;
          embedding = await generateEmbedding(text);
          embedded++;
        } catch (e) {
          console.warn(`[PatternRAG] sync failed for ${p.id}:`, (e as Error).message);
          skipped++;
          continue;
        }
      }

      const stored: StoredAutomationPattern = {
        id: p.id,
        name: p.name,
        description: p.description,
        risk: p.risk,
        supportedIntents: p.supportedIntents,
        requiredInputs: p.requiredInputs,
        requiredCredentials: p.requiredCredentials,
        forbiddenWithoutApproval: p.forbiddenWithoutApproval,
        executable: p.executable !== false,
        maturity: p.maturity,
        n8nCommunityCompatible: p.n8nCommunityCompatible,
        builderId: p.id,
        embedding,
        createdAt: existing?.createdAt ?? new Date(),
        updatedAt: new Date(),
      };

      await col.updateOne({ id: p.id }, { $set: stored }, { upsert: true });
      synced++;
    }

    return { synced, embedded, skipped };
  },
});

export const matchPatternTool = createTool({
  id: 'architect.match_pattern',
  description:
    'Wyszukuje top-K patternów najlepiej pasujących do specyfikacji automatyzacji (semantic search po embedingach). Domyślnie zwraca tylko executable patterny. Każdy match zawiera `executable` i `maturity` — tylko `executable: true` mozna podac do architect.compose_workflow.',
  inputSchema: z.object({
    name: z.string().describe('Krótka nazwa zadania, np. "Webhook do CRM"'),
    description: z.string().describe('Opis czego ma robić workflow'),
    goal: z.string().describe('Cel biznesowy'),
    topK: z.number().default(3),
    includeAbstract: z
      .boolean()
      .default(false)
      .describe('Jezeli true, zwraca takze abstract patterns jako reasoning context (oznaczone executable: false).'),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        risk: z.enum(['low', 'medium', 'high', 'critical']),
        requiredInputs: z.array(z.string()),
        requiredCredentials: z.array(z.string()),
        forbiddenWithoutApproval: z.boolean(),
        executable: z.boolean(),
        maturity: z.enum(['draft', 'tested', 'production']).optional(),
        score: z.number(),
      }),
    ),
    message: z.string(),
  }),
  execute: async (context) => {
    try {
      const queryText = `${context.name}: ${context.description} ${context.goal}`;
      const queryEmbedding = await generateEmbedding(queryText);

      const db = await getDb();
      const col = db.collection<StoredAutomationPattern>(COLLECTION);
      const stored = await col.find({ embedding: { $exists: true } }).toArray();

      if (stored.length === 0) {
        return {
          matches: [],
          message: 'Brak patternów w bazie. Wywołaj architect.sync_patterns najpierw.',
        };
      }

      const scored = stored
        .map((p) => ({
          pattern: p,
          score: cosineSimilarity(queryEmbedding, p.embedding!),
        }))
        .filter((s) => s.score >= MIN_SIMILARITY)
        .filter((s) => context.includeAbstract || s.pattern.executable !== false)
        .sort((a, b) => b.score - a.score)
        .slice(0, context.topK);

      const executableCount = scored.filter((s) => s.pattern.executable !== false).length;

      return {
        matches: scored.map(({ pattern, score }) => ({
          id: pattern.id,
          name: pattern.name,
          description: pattern.description,
          risk: pattern.risk,
          requiredInputs: pattern.requiredInputs,
          requiredCredentials: pattern.requiredCredentials,
          forbiddenWithoutApproval: pattern.forbiddenWithoutApproval,
          executable: pattern.executable !== false,
          maturity: pattern.maturity,
          score,
        })),
        message:
          scored.length > 0
            ? `Znaleziono ${scored.length} patternów (${executableCount} executable)`
            : 'Brak dopasowań > 0.35 — rozważ stworzenie nowego patternu lub uściślenie opisu',
      };
    } catch (error) {
      return {
        matches: [],
        message: `Błąd RAG: ${(error as Error).message}`,
      };
    }
  },
});
