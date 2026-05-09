/**
 * Skill Registry (Phase 2.2)
 *
 * Manages the lifecycle of agent skills:
 *   1. Scans _skills/ directory for *.md files with YAML frontmatter
 *   2. Parses metadata (name, description, category, keywords, etc.)
 *   3. Generates embeddings for semantic search
 *   4. Provides search/load/report APIs
 *
 * Compatible with both existing skills (name, category, description, keywords)
 * and the extended agentskills.io format (allowedTools, minComplexity, etc.).
 *
 * Usage:
 *   import { getSkillRegistry } from './services/skill-registry.js';
 *   const registry = getSkillRegistry();
 *   await registry.initialize('./src/mastra/_skills');
 *
 *   const results = await registry.search('fix typescript error');
 *   const skill = await registry.load('git-conflict-resolver');
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, basename, extname } from 'path';
import { parseFrontmatter, updateFrontmatter } from '../lib/yaml-frontmatter.js';
import { generateEmbedding, cosineSimilarity } from '../lib/embedder.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskComplexity = 'trivial' | 'simple' | 'medium' | 'complex' | 'critical';

export interface SkillMetadata {
  /** Unique skill name (from frontmatter or derived from filename) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Category/domain (e.g., 'terminal', 'coding', 'n8n') */
  category?: string;
  /** Search keywords */
  keywords?: string[];
  /** Allowed tools for this skill */
  allowedTools?: string[];
  /** Minimum task complexity this skill handles */
  minComplexity?: TaskComplexity;
  /** Estimated token usage */
  estimatedTokens?: number;
  /** Expected output format */
  outputFormat?: string;
  /** Semantic tags for matching */
  tags?: string[];
  /** Skill version */
  version?: number;
  /** Feedback: success rate (0-1) */
  successRate?: number | null;
  /** Feedback: total uses */
  totalUses?: number;
  /** Feedback: last used timestamp */
  lastUsed?: string | null;
  /** Author */
  author?: string;
  /** Any extra metadata fields */
  [key: string]: any;
}

export interface Skill {
  metadata: SkillMetadata;
  /** Markdown body (without frontmatter) */
  procedure: string;
  /** Absolute path to the skill file */
  filePath: string;
  /** Embedding vector for semantic search */
  embedding: number[];
}

export interface SkillSearchResult extends Skill {
  /** Cosine similarity score */
  score: number;
}

// ── Skill Registry ───────────────────────────────────────────────────────────

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private initialized = false;
  private skillsDir = '';

  /**
   * Scan _skills/ directory, parse frontmatter, build embedding index.
   * Handles nested directories (e.g., _skills/terminal/*.md, _skills/coding/*.md).
   * Ignores non-markdown files (JSON blocks, etc.).
   */
  async initialize(skillsDir: string): Promise<void> {
    this.skillsDir = skillsDir;
    this.skills.clear();

    const mdFiles = await this._findMarkdownFiles(skillsDir);
    console.log(`[SkillRegistry] Found ${mdFiles.length} skill files in ${skillsDir}`);

    const embeddingPromises: Promise<void>[] = [];

    for (const filePath of mdFiles) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const { metadata: rawMeta, body } = parseFrontmatter(content);

        // Derive name from frontmatter or filename
        const name = rawMeta.name || basename(filePath, extname(filePath));

        // Derive category from parent directory
        const relPath = relative(skillsDir, filePath);
        const category = rawMeta.category || relPath.split('/')[0] || 'general';

        const metadata: SkillMetadata = {
          name,
          description: rawMeta.description || '',
          category,
          keywords: Array.isArray(rawMeta.keywords) ? rawMeta.keywords : [],
          allowedTools: Array.isArray(rawMeta.allowedTools) ? rawMeta.allowedTools : undefined,
          minComplexity: rawMeta.minComplexity as TaskComplexity | undefined,
          estimatedTokens: rawMeta.estimatedTokens ? Number(rawMeta.estimatedTokens) : undefined,
          outputFormat: rawMeta.outputFormat,
          tags: Array.isArray(rawMeta.tags) ? rawMeta.tags : undefined,
          version: rawMeta.version ? Number(rawMeta.version) : undefined,
          successRate: rawMeta.success_rate != null ? Number(rawMeta.success_rate) : null,
          totalUses: rawMeta.total_uses ? Number(rawMeta.total_uses) : 0,
          lastUsed: rawMeta.last_used || null,
          author: rawMeta.author,
        };

        const skill: Skill = {
          metadata,
          procedure: body,
          filePath,
          embedding: [],
        };

        this.skills.set(name, skill);

        // Generate embedding asynchronously
        if (metadata.description) {
          embeddingPromises.push(
            this._generateSkillEmbedding(name, metadata)
              .catch(err => {
                console.warn(`[SkillRegistry] Embedding failed for ${name}:`, (err as Error).message);
              }),
          );
        }
      } catch (err) {
        console.warn(`[SkillRegistry] Failed to parse ${filePath}:`, (err as Error).message);
      }
    }

    // Wait for all embeddings (non-blocking, errors caught above)
    await Promise.allSettled(embeddingPromises);

    this.initialized = true;
    const withEmbeddings = [...this.skills.values()].filter(s => s.embedding.length > 0).length;
    console.log(`[SkillRegistry] Initialized: ${this.skills.size} skills, ${withEmbeddings} with embeddings`);
  }

  /**
   * Semantic search over registered skills.
   * Returns skills ranked by cosine similarity to the query.
   */
  async search(
    query: string,
    opts: { category?: string; topK?: number; minScore?: number } = {},
  ): Promise<SkillSearchResult[]> {
    const { category, topK = 5, minScore = 0.3 } = opts;

    if (!this.initialized || this.skills.size === 0) {
      return [];
    }

    let candidates = [...this.skills.values()];
    if (category) {
      candidates = candidates.filter(s => s.metadata.category === category);
    }

    // Try semantic search first
    const withEmbeddings = candidates.filter(s => s.embedding.length > 0);

    if (withEmbeddings.length > 0) {
      const queryVec = await generateEmbedding(query);

      return withEmbeddings
        .map(skill => ({
          ...skill,
          score: cosineSimilarity(queryVec, skill.embedding),
        }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }

    // Fallback: keyword matching
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/);

    return candidates
      .map(skill => {
        const searchText = [
          skill.metadata.name,
          skill.metadata.description,
          ...(skill.metadata.keywords || []),
          ...(skill.metadata.tags || []),
        ].join(' ').toLowerCase();

        const matchCount = queryTerms.filter(t => searchText.includes(t)).length;
        const score = matchCount / queryTerms.length;

        return { ...skill, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Load a skill by name. Returns full skill with procedure.
   */
  async load(skillName: string): Promise<Skill | null> {
    const skill = this.skills.get(skillName);
    if (!skill) return null;

    // Re-read file to get latest content (in case frontmatter was updated)
    try {
      const content = await readFile(skill.filePath, 'utf-8');
      const { body } = parseFrontmatter(content);
      return { ...skill, procedure: body };
    } catch {
      return skill;
    }
  }

  /**
   * Report skill usage result — updates success_rate in YAML frontmatter.
   * This creates a feedback loop: skills with low success_rate can be
   * improved or deprioritized.
   */
  async reportResult(
    skillName: string,
    success: boolean,
    notes?: string,
  ): Promise<{ updated: boolean; newSuccessRate: number | null }> {
    const skill = this.skills.get(skillName);
    if (!skill) return { updated: false, newSuccessRate: null };

    const totalUses = (skill.metadata.totalUses || 0) + 1;
    const previousRate = skill.metadata.successRate ?? 1.0;
    // Rolling average: blend old rate with new result
    const newSuccessRate = previousRate === null
      ? (success ? 1.0 : 0.0)
      : (previousRate * (totalUses - 1) + (success ? 1 : 0)) / totalUses;

    const roundedRate = Math.round(newSuccessRate * 100) / 100;

    try {
      await updateFrontmatter(skill.filePath, {
        success_rate: roundedRate,
        total_uses: totalUses,
        last_used: new Date().toISOString().split('T')[0],
      });

      // Update in-memory
      skill.metadata.successRate = roundedRate;
      skill.metadata.totalUses = totalUses;
      skill.metadata.lastUsed = new Date().toISOString().split('T')[0];

      return { updated: true, newSuccessRate: roundedRate };
    } catch (err) {
      console.warn(`[SkillRegistry] Failed to update ${skillName}:`, (err as Error).message);
      return { updated: false, newSuccessRate: roundedRate };
    }
  }

  /**
   * List all registered skills (metadata only, no procedure body).
   */
  list(opts: { category?: string } = {}): SkillMetadata[] {
    let skills = [...this.skills.values()];
    if (opts.category) {
      skills = skills.filter(s => s.metadata.category === opts.category);
    }
    return skills.map(s => s.metadata);
  }

  /**
   * Get categories with skill counts.
   */
  categories(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const skill of this.skills.values()) {
      const cat = skill.metadata.category || 'general';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _findMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stats = await stat(fullPath);

        if (stats.isDirectory()) {
          const nested = await this._findMarkdownFiles(fullPath);
          results.push(...nested);
        } else if (entry.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return results;
  }

  private async _generateSkillEmbedding(name: string, meta: SkillMetadata): Promise<void> {
    // Build searchable text from metadata
    const searchText = [
      meta.description,
      ...(meta.keywords || []),
      ...(meta.tags || []),
      meta.category,
    ].filter(Boolean).join('. ');

    const embedding = await generateEmbedding(searchText);
    const skill = this.skills.get(name);
    if (skill) {
      skill.embedding = embedding;
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!_instance) {
    _instance = new SkillRegistry();
  }
  return _instance;
}
