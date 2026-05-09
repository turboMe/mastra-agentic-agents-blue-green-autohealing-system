/**
 * OpenRouter Gateway (Phase 4.1)
 *
 * Provides access to OpenRouter's free-tier models via the Mastra Gateway
 * interface. Uses @ai-sdk/openai-compatible since OpenRouter is fully
 * compatible with OpenAI Chat Completions format.
 *
 * Key features from OpenRouter API:
 * - `models: [...]` fallback lists (handled server-side by OpenRouter)
 * - `provider.require_parameters: true` — enforces JSON mode support
 * - `provider.data_collection: "deny"` — prevents training on our code
 * - Response includes `data.model` — which model was actually used
 *
 * Model ID format: openrouter/<provider>/<model>:free
 * Example: openrouter/nvidia/nemotron-3-super-120b-a12b:free
 *
 * The gateway registers multiple "providers" (nvidia, poolside, etc.)
 * so Mastra can route to them via 3-segment IDs.
 */

import { MastraModelGateway } from '@mastra/core/llm';
import type { ProviderConfig, GatewayLanguageModel } from '@mastra/core/llm';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { models } from '../config/model-manifest.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ── Free models — generated from model-manifest.ts ───────────────────────────

/**
 * Derives FREE_MODELS from model-manifest inventory.
 * Any model whose full ID starts with 'openrouter/' is included.
 * Provider namespace and model name are extracted from the ID segments.
 *
 * manifest: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free'
 *       → { id: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'nvidia', model: 'nemotron-3-super-120b-a12b:free' }
 */
const FREE_MODELS: Array<{ id: string; provider: string; model: string }> = (Object.values(models) as string[])
  .filter((fullId) => fullId.startsWith('openrouter/'))
  .map((fullId) => {
    // 'openrouter/nvidia/nemotron-3-super-120b-a12b:free' → 'nvidia/nemotron-3-super-120b-a12b:free'
    const withoutGateway = fullId.replace('openrouter/', '');
    const slashIdx = withoutGateway.indexOf('/');
    const provider = withoutGateway.slice(0, slashIdx);
    const model = withoutGateway.slice(slashIdx + 1);
    // Special case: 'openai' provider collides with paid OpenAI — use 'openai-oss'
    const safeProvider = provider === 'openai' ? 'openai-oss' : provider;
    return { id: withoutGateway, provider: safeProvider, model };
  });

// ── Gateway Implementation ───────────────────────────────────────────────────

export class OpenRouterGateway extends MastraModelGateway {
  readonly id = 'openrouter';
  readonly name = 'OpenRouter (cloud-free)';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.warn('[OpenRouterGateway] OPENROUTER_API_KEY not set — gateway disabled');
      return {};
    }

    // Group models by provider namespace
    const byProvider: Record<string, string[]> = {};
    for (const m of FREE_MODELS) {
      (byProvider[m.provider] ??= []).push(m.model);
    }

    const result: Record<string, ProviderConfig> = {};
    for (const [provider, modelList] of Object.entries(byProvider)) {
      result[provider] = {
        name: `OpenRouter: ${provider}`,
        models: modelList,
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        gateway: 'openrouter',
      };
    }

    return result;
  }

  buildUrl(_modelId: string): string {
    return OPENROUTER_BASE_URL;
  }

  async getApiKey(): Promise<string> {
    return process.env.OPENROUTER_API_KEY ?? '';
  }

  async resolveLanguageModel({
    modelId,
    providerId,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('[OpenRouterGateway] OPENROUTER_API_KEY not set');
    }

    // Reconstruct full model name for OpenRouter API
    // providerId = "nvidia", modelId = "nemotron-3-super-120b-a12b:free"
    // OpenRouter expects: "nvidia/nemotron-3-super-120b-a12b:free"
    const fullModelName = `${providerId}/${modelId}`;

    const provider = createOpenAICompatible({
      name: `openrouter-${providerId}`,
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      headers: {
        'HTTP-Referer': 'https://agentic-agents.local',
        'X-OpenRouter-Title': 'Agentic Agents Coding System',
      },
    });

    return provider.chatModel(fullModelName);
  }
}
