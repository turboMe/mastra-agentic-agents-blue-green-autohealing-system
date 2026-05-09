/**
 * Model Availability Service (Etap 8.1)
 *
 * Verifies that models listed in the Model Capability Registry are actually
 * available at runtime. Updates `available` flag in-memory so SmartRouter
 * skips unavailable models during dispatch.
 *
 * Two check types:
 * 1. Local (Ollama): `ollama list` — are models pulled and loadable?
 * 2. Cloud (API): lightweight ping to each provider endpoint
 *
 * Results are cached with configurable TTL to avoid hammering services.
 */

import { execSync } from 'child_process';
import { modelRegistry, type ModelCapability } from '../config/model-capabilities.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelAvailabilityResult {
  modelId: string;
  name: string;
  available: boolean;
  reason: 'loaded' | 'pullable' | 'not_found' | 'ollama_unreachable' | 'api_ok' | 'api_unreachable' | 'api_auth_error' | 'skipped';
  checkedAt: Date;
}

export interface AvailabilitySummary {
  results: ModelAvailabilityResult[];
  localAvailable: number;
  localUnavailable: number;
  cloudAvailable: number;
  cloudUnavailable: number;
  totalChecked: number;
  registryUpdated: boolean;
  checkedAt: Date;
}

// ── Cache ────────────────────────────────────────────────────────────────────

let _cachedSummary: AvailabilitySummary | null = null;
let _cacheExpiry = 0;

const CACHE_TTL_MS = parseInt(process.env.MODEL_AVAILABILITY_CACHE_TTL_MS ?? '60000', 10); // 60s default

// ── Ollama Check ─────────────────────────────────────────────────────────────

/**
 * Parse output of `ollama list` into a set of available model tags.
 * Handles both tagged (qwen3:1.7b) and untagged (qwen3) formats.
 */
function parseOllamaList(): Set<string> {
  try {
    const raw = execSync('ollama list', {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const models = new Set<string>();
    const lines = raw.trim().split('\n');

    // Skip header line ("NAME  ID  SIZE  MODIFIED")
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // First column is the model name/tag
      const modelName = line.split(/\s+/)[0];
      if (modelName) {
        models.add(modelName.toLowerCase());

        // Also add without :latest suffix for matching
        if (modelName.endsWith(':latest')) {
          models.add(modelName.replace(':latest', '').toLowerCase());
        }
      }
    }

    return models;
  } catch (err) {
    console.error('[ModelAvailability] Failed to run `ollama list`:', (err as Error).message);
    return new Set(); // Empty = all local models marked unavailable
  }
}

/**
 * Extract the Ollama model tag from a Mastra modelId.
 * e.g. 'ollama/local/qwen3:1.7b' → 'qwen3:1.7b'
 *      'ollama/local/phi4-reasoning:14b' → 'phi4-reasoning:14b'
 */
function extractOllamaTag(modelId: string): string | null {
  // Format: 'ollama/local/<model-tag>' or 'ollama/<model-tag>'
  const match = modelId.match(/^ollama\/(?:local\/)?(.+)$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Check which local Ollama models from the registry are actually available.
 */
function checkOllamaModels(localModels: ModelCapability[]): ModelAvailabilityResult[] {
  const availableModels = parseOllamaList();
  const ollamaReachable = availableModels.size > 0 || isOllamaRunning();

  return localModels.map((model) => {
    const tag = extractOllamaTag(model.modelId);

    if (!tag) {
      return {
        modelId: model.modelId,
        name: model.name,
        available: false,
        reason: 'not_found' as const,
        checkedAt: new Date(),
      };
    }

    if (!ollamaReachable) {
      return {
        modelId: model.modelId,
        name: model.name,
        available: false,
        reason: 'ollama_unreachable' as const,
        checkedAt: new Date(),
      };
    }

    // Check if the model tag exists in ollama list output
    // Try exact match, then base name without tag
    const found = availableModels.has(tag) ||
      availableModels.has(tag.split(':')[0]);

    return {
      modelId: model.modelId,
      name: model.name,
      available: found,
      reason: found ? 'loaded' as const : 'not_found' as const,
      checkedAt: new Date(),
    };
  });
}

function isOllamaRunning(): boolean {
  try {
    execSync('pgrep -x ollama', { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// ── Cloud Check ──────────────────────────────────────────────────────────────

/**
 * Lightweight cloud endpoint verification.
 * We don't make actual LLM calls — just verify the API key / endpoint works.
 */
async function checkCloudModels(cloudModels: ModelCapability[]): Promise<ModelAvailabilityResult[]> {
  // Group by provider to avoid redundant checks
  const providers = new Map<string, ModelCapability[]>();
  for (const model of cloudModels) {
    const provider = model.modelId.split('/')[0]; // 'google', 'openai', 'anthropic'
    const group = providers.get(provider) ?? [];
    group.push(model);
    providers.set(provider, group);
  }

  const results: ModelAvailabilityResult[] = [];

  const providerChecks = [...providers.entries()].map(async ([provider, models]) => {
    const isReachable = await checkProviderReachable(provider);

    for (const model of models) {
      results.push({
        modelId: model.modelId,
        name: model.name,
        available: isReachable,
        reason: isReachable ? 'api_ok' : 'api_unreachable',
        checkedAt: new Date(),
      });
    }
  });

  await Promise.allSettled(providerChecks);
  return results;
}

/**
 * Check if a cloud provider's API is reachable.
 * Uses the lightest possible request per provider.
 */
async function checkProviderReachable(provider: string): Promise<boolean> {
  const TIMEOUT_MS = 5000;

  try {
    switch (provider) {
      case 'google': {
        const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!key) return false;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1`,
            { signal: controller.signal },
          );
          return res.ok;
        } finally {
          clearTimeout(timer);
        }
      }

      case 'openai': {
        const key = process.env.OPENAI_API_KEY;
        if (!key) return false;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch('https://api.openai.com/v1/models?limit=1', {
            headers: { Authorization: `Bearer ${key}` },
            signal: controller.signal,
          });
          return res.ok;
        } finally {
          clearTimeout(timer);
        }
      }

      case 'anthropic': {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) return false;
        // Anthropic doesn't have a /models list endpoint — check key validity
        // via a minimal request that returns fast (even if it errors with 400,
        // a 401 means bad key, anything else means reachable)
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ model: 'claude-haiku-4-6', max_tokens: 1, messages: [] }),
            signal: controller.signal,
          });
          // 400 = reachable but invalid request (expected), 401 = bad key
          return res.status !== 401;
        } finally {
          clearTimeout(timer);
        }
      }

      default:
        console.warn(`[ModelAvailability] Unknown provider: ${provider}`);
        return false;
    }
  } catch (err) {
    console.warn(`[ModelAvailability] Provider ${provider} unreachable:`, (err as Error).message);
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Verify all models in the registry and update their `available` flags in-memory.
 *
 * Results are cached for CACHE_TTL_MS. Use `forceRefresh` to bypass cache.
 */
export async function verifyAllModels(forceRefresh = false): Promise<AvailabilitySummary> {
  const now = Date.now();

  // Return cached if fresh
  if (!forceRefresh && _cachedSummary && now < _cacheExpiry) {
    return _cachedSummary;
  }

  const localModels = modelRegistry.filter((m) => m.vramMb > 0);
  const cloudModels = modelRegistry.filter((m) => m.vramMb === 0);

  // Run local checks synchronously (fast, exec-based)
  const localResults = checkOllamaModels(localModels);

  // Run cloud checks in parallel with timeout
  const cloudResults = await checkCloudModels(cloudModels);

  const allResults = [...localResults, ...cloudResults];

  // ── Update registry in-memory ──
  let updatedCount = 0;
  for (const result of allResults) {
    const registryEntry = modelRegistry.find((m) => m.modelId === result.modelId);
    if (registryEntry && registryEntry.available !== result.available) {
      registryEntry.available = result.available;
      updatedCount++;
    }
  }

  const summary: AvailabilitySummary = {
    results: allResults,
    localAvailable: localResults.filter((r) => r.available).length,
    localUnavailable: localResults.filter((r) => !r.available).length,
    cloudAvailable: cloudResults.filter((r) => r.available).length,
    cloudUnavailable: cloudResults.filter((r) => !r.available).length,
    totalChecked: allResults.length,
    registryUpdated: updatedCount > 0,
    checkedAt: new Date(),
  };

  _cachedSummary = summary;
  _cacheExpiry = now + CACHE_TTL_MS;

  return summary;
}

/**
 * Quick check — only verify models used in a specific routing plan.
 * Much faster than full verification when you only need a few models.
 */
export async function verifyPlanModels(modelIds: string[]): Promise<ModelAvailabilityResult[]> {
  const uniqueIds = [...new Set(modelIds)];
  const results: ModelAvailabilityResult[] = [];

  // Check local models
  const localIds = uniqueIds.filter((id) => id.startsWith('ollama/'));
  if (localIds.length > 0) {
    const availableModels = parseOllamaList();
    for (const id of localIds) {
      const tag = extractOllamaTag(id);
      const found = tag ? (availableModels.has(tag) || availableModels.has(tag.split(':')[0])) : false;
      const model = modelRegistry.find((m) => m.modelId === id);
      results.push({
        modelId: id,
        name: model?.name ?? id,
        available: found,
        reason: found ? 'loaded' : 'not_found',
        checkedAt: new Date(),
      });
    }
  }

  // Check cloud models (grouped by provider)
  const cloudIds = uniqueIds.filter((id) => !id.startsWith('ollama/'));
  if (cloudIds.length > 0) {
    const providers = new Set(cloudIds.map((id) => id.split('/')[0]));
    const providerStatus = new Map<string, boolean>();

    await Promise.allSettled(
      [...providers].map(async (p) => {
        providerStatus.set(p, await checkProviderReachable(p));
      }),
    );

    for (const id of cloudIds) {
      const provider = id.split('/')[0];
      const reachable = providerStatus.get(provider) ?? false;
      const model = modelRegistry.find((m) => m.modelId === id);
      results.push({
        modelId: id,
        name: model?.name ?? id,
        available: reachable,
        reason: reachable ? 'api_ok' : 'api_unreachable',
        checkedAt: new Date(),
      });
    }
  }

  // Update registry in-memory
  for (const result of results) {
    const entry = modelRegistry.find((m) => m.modelId === result.modelId);
    if (entry) entry.available = result.available;
  }

  return results;
}

// ── Startup Init ─────────────────────────────────────────────────────────────

/**
 * Initialize model availability at startup. Call in index.ts after initGpuGuard().
 * Logs a summary of available/unavailable models.
 */
export async function initModelAvailability(): Promise<void> {
  console.log('[ModelAvailability] Checking model availability at startup...');

  const summary = await verifyAllModels(true);

  // Log summary
  console.log(
    `[ModelAvailability] ✅ Local: ${summary.localAvailable}/${summary.localAvailable + summary.localUnavailable} available | ` +
    `Cloud: ${summary.cloudAvailable}/${summary.cloudAvailable + summary.cloudUnavailable} available`,
  );

  // Log unavailable models as warnings
  const unavailable = summary.results.filter((r) => !r.available);
  if (unavailable.length > 0) {
    console.warn(
      `[ModelAvailability] ⚠️ Unavailable models:\n` +
      unavailable.map((r) => `  - ${r.name} (${r.modelId}): ${r.reason}`).join('\n'),
    );
  }

  if (summary.registryUpdated) {
    console.log(`[ModelAvailability] Registry updated — ${summary.results.filter((r) => !r.available).length} models marked unavailable`);
  }
}

/**
 * Format availability summary for logging/diagnostics.
 */
export function formatAvailabilitySummary(summary: AvailabilitySummary): string {
  const lines: string[] = [
    `\n═══ Model Availability ═══`,
    `  Local:  ${summary.localAvailable} available, ${summary.localUnavailable} unavailable`,
    `  Cloud:  ${summary.cloudAvailable} available, ${summary.cloudUnavailable} unavailable`,
    `  Total:  ${summary.totalChecked} checked at ${summary.checkedAt.toISOString()}`,
    '',
  ];

  for (const r of summary.results) {
    const icon = r.available ? '✅' : '❌';
    const type = r.modelId.startsWith('ollama/') ? '🖥️' : '☁️';
    lines.push(`  ${icon} ${type} ${r.name} — ${r.reason}`);
  }

  return lines.join('\n');
}
