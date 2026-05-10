/**
 * Anthropic prompt-caching helper.
 *
 * Cache reads on Claude cost ~10× less than normal input tokens
 * (Sonnet 4.6: $3/1M input → $0.30/1M cached read; Haiku 4.6 proportionally).
 * The marker tells Anthropic: "everything before this point can be cached
 * for ~5 minutes, charge me 90% less on subsequent reads".
 *
 * In Mastra, providerOptions.anthropic.cacheControl applied at call level
 * marks the system prompt as cacheable — which is exactly the static, reusable
 * prefix in long agent rounds.
 */

const ANTHROPIC_CACHE_OPTIONS = {
  anthropic: { cacheControl: { type: 'ephemeral' as const } },
} as const;

type CacheOptionResult = { providerOptions: typeof ANTHROPIC_CACHE_OPTIONS } | Record<string, never>;

/**
 * Returns cache-enabling providerOptions iff the resolved model is Anthropic.
 * Empty object otherwise — safe to spread:
 *
 *   await agent.generate(prompt, {
 *     model: modelId,
 *     ...cacheOptionsForModel(modelId),
 *   });
 */
export function cacheOptionsForModel(modelId?: string): CacheOptionResult {
  if (!modelId) return {};
  return modelId.startsWith('anthropic/')
    ? { providerOptions: ANTHROPIC_CACHE_OPTIONS }
    : {};
}

/**
 * Returns cache options unconditionally — use for agents pinned to Anthropic
 * (e.g. codeReviewAgent on Haiku 4.6).
 */
export function anthropicCacheOptions(): { providerOptions: typeof ANTHROPIC_CACHE_OPTIONS } {
  return { providerOptions: ANTHROPIC_CACHE_OPTIONS };
}
