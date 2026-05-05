import { MastraModelGateway } from '@mastra/core/llm';
import type { ProviderConfig, GatewayLanguageModel } from '@mastra/core/llm';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

export class OllamaGateway extends MastraModelGateway {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      if (!res.ok) return {};
      const { models } = (await res.json()) as { models: Array<{ name: string }> };

      // Mastra wymaga 3-segmentowego ID: gateway/provider/model.
      // Grupujemy modele po prefiksie namespace (np. "huihui_ai/qwen:9b" → provider=huihui_ai, model=qwen:9b).
      // Modele bez prefiksu (np. "gemma4:26b") trafiają do pseudo-providera "local".
      const byProvider: Record<string, string[]> = {};
      for (const m of models) {
        const idx = m.name.indexOf('/');
        if (idx > 0) {
          const provider = m.name.slice(0, idx);
          const model = m.name.slice(idx + 1);
          (byProvider[provider] ??= []).push(model);
        } else {
          (byProvider['local'] ??= []).push(m.name);
        }
      }

      const result: Record<string, ProviderConfig> = {};
      for (const [provider, modelList] of Object.entries(byProvider)) {
        result[provider] = {
          name: provider === 'local' ? 'Ollama (local)' : `Ollama: ${provider}`,
          models: modelList,
          apiKeyEnvVar: 'OLLAMA_API_KEY',
          gateway: 'ollama',
        };
      }
      return result;
    } catch {
      return {};
    }
  }

  buildUrl(_modelId: string): string {
    return `${OLLAMA_BASE_URL}/v1`;
  }

  async getApiKey(): Promise<string> {
    return 'ollama';
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
    // Rekonstruuj pełną nazwę dla Ollama API:
    // - "local" oznacza model bez prefiksu (np. "gemma4:26b")
    // - inny providerId = namespace, więc Ollama oczekuje "namespace/model"
    const fullName = providerId === 'local' ? modelId : `${providerId}/${modelId}`;
    const provider = createOpenAICompatible({
      name: providerId,
      apiKey: 'ollama',
      baseURL: `${OLLAMA_BASE_URL}/v1`,
    });
    return provider.chatModel(fullName);
  }
}
