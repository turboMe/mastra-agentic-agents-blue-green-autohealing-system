/**
 * Model pricing reference (USD per 1M tokens).
 * Used by services/dashboard-stats.ts to compute cost per task / agent / model.
 *
 * Prices are hardcoded for v1 (MVP). Future: move to MongoDB collection
 * `model_pricing` with effectiveFrom/effectiveTo for historical accuracy.
 *
 * Local models (Ollama) are priced at 0 — no API cost.
 * Override via env: MODEL_PRICING_OVERRIDE_JSON='{"my-model":{"input":1.0,"output":2.0}}'
 */

export interface ModelPrice {
  /** USD per 1M input tokens */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
  /** Provider name (for grouping) */
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama' | 'unknown';
}

/**
 * Default pricing as of 2026-05.
 * Sources: https://www.anthropic.com/pricing, https://openai.com/api/pricing,
 * https://ai.google.dev/pricing, https://openrouter.ai/models
 */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPrice> = {
  // ── Anthropic Claude ──────────────────────────────────────────────
  'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75, provider: 'anthropic' },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-haiku-4-5-20251001': { inputPer1M: 1, outputPer1M: 5, provider: 'anthropic' },
  'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5, provider: 'anthropic' },

  // ── OpenAI ────────────────────────────────────────────────────────
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, provider: 'openai' },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, provider: 'openai' },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30, provider: 'openai' },
  'o1': { inputPer1M: 15, outputPer1M: 60, provider: 'openai' },
  'o1-mini': { inputPer1M: 3, outputPer1M: 12, provider: 'openai' },

  // ── Google Gemini ─────────────────────────────────────────────────
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 5, provider: 'google' },
  'gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3, provider: 'google' },
  'google/gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 5, provider: 'google' },
  'google/gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3, provider: 'google' },

  // ── OpenRouter free tier (cost = 0) ───────────────────────────────
  // Free models are subject to rate limits but have no per-token cost
  'openrouter/auto': { inputPer1M: 0, outputPer1M: 0, provider: 'openrouter' },

  // ── Ollama local models (cost = 0, runs on local GPU) ─────────────
  'qwen3:4b': { inputPer1M: 0, outputPer1M: 0, provider: 'ollama' },
  'qwen3:8b': { inputPer1M: 0, outputPer1M: 0, provider: 'ollama' },
  'qwen3:14b': { inputPer1M: 0, outputPer1M: 0, provider: 'ollama' },
  'llama3.1:8b': { inputPer1M: 0, outputPer1M: 0, provider: 'ollama' },
  'llama3.1:70b': { inputPer1M: 0, outputPer1M: 0, provider: 'ollama' },
};

let _pricingCache: Record<string, ModelPrice> | null = null;

/**
 * Returns the merged pricing table (defaults + env override).
 * Cached after first call.
 */
function loadPricing(): Record<string, ModelPrice> {
  if (_pricingCache) return _pricingCache;

  const merged = { ...DEFAULT_MODEL_PRICING };

  const overrideJson = process.env.MODEL_PRICING_OVERRIDE_JSON;
  if (overrideJson) {
    try {
      const override = JSON.parse(overrideJson) as Record<string, Partial<ModelPrice>>;
      for (const [model, partial] of Object.entries(override)) {
        merged[model] = {
          inputPer1M: partial.inputPer1M ?? merged[model]?.inputPer1M ?? 0,
          outputPer1M: partial.outputPer1M ?? merged[model]?.outputPer1M ?? 0,
          provider: partial.provider ?? merged[model]?.provider ?? 'unknown',
        };
      }
    } catch (err) {
      console.warn('[ModelPricing] Failed to parse MODEL_PRICING_OVERRIDE_JSON:', (err as Error).message);
    }
  }

  _pricingCache = merged;
  return merged;
}

/**
 * Get pricing for a specific model. Falls back to a `provider: 'unknown'`
 * record with 0 cost if model is not registered (returns undefined-equivalent
 * but typed as zero so callers don't need to null-check).
 */
export function getModelPricing(model: string): ModelPrice {
  const pricing = loadPricing();

  if (pricing[model]) return pricing[model]!;

  // Try fuzzy match on provider prefix (e.g. "anthropic/claude-sonnet-4-6")
  const slash = model.indexOf('/');
  if (slash > 0) {
    const tail = model.slice(slash + 1);
    if (pricing[tail]) return pricing[tail]!;
  }

  return { inputPer1M: 0, outputPer1M: 0, provider: 'unknown' };
}

/**
 * Calculate USD cost for a single completion.
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = getModelPricing(model);
  const inputCost = (promptTokens / 1_000_000) * price.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * price.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Batch cost calculation for an array of token usages.
 */
export function aggregateCost(
  records: Array<{ model: string; promptTokens: number; completionTokens: number }>,
): { totalUsd: number; byModel: Record<string, { tokens: number; usd: number }> } {
  const byModel: Record<string, { tokens: number; usd: number }> = {};
  let totalUsd = 0;

  for (const r of records) {
    const cost = calculateCost(r.model, r.promptTokens, r.completionTokens);
    totalUsd += cost;
    if (!byModel[r.model]) byModel[r.model] = { tokens: 0, usd: 0 };
    byModel[r.model]!.tokens += r.promptTokens + r.completionTokens;
    byModel[r.model]!.usd += cost;
  }

  return { totalUsd, byModel };
}

/**
 * List all registered models (for dashboard introspection).
 */
export function listKnownModels(): Array<{ model: string; pricing: ModelPrice }> {
  const pricing = loadPricing();
  return Object.entries(pricing).map(([model, p]) => ({ model, pricing: p }));
}

/**
 * Reset the cache — useful for tests or when env vars change at runtime.
 */
export function resetPricingCache(): void {
  _pricingCache = null;
}
