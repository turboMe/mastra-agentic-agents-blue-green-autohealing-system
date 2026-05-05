import { AutomationSpec } from '../types.js';

/**
 * Runtime configuration for n8n workflow generation.
 * Replaces $vars.* which is NOT available in n8n Community Edition.
 * Values are injected at workflow generation time from process.env.
 */
export interface N8nRuntimeConfig {
  telegramChatId: string;
  ollamaBaseUrl: string;
  defaultLocalModel: string;
  reasoningLocalModel: string;
  agentForgeTaskEndpoint: string;
  agentForgeMemoryEndpoint: string;
  agentForgeCrmEndpoint: string;
  agentForgeApprovalEndpoint: string;
  geminiGatewayEndpoint: string;
  webhookSharedSecret: string;
}

/**
 * Reads n8n config from environment variables.
 * Called at workflow generation time — values are baked into the workflow JSON.
 */
export function getN8nConfig(): N8nRuntimeConfig {
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
  return {
    telegramChatId: process.env.N8N_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    defaultLocalModel: process.env.OLLAMA_DEFAULT_MODEL || 'gemma4:26b',
    reasoningLocalModel: process.env.OLLAMA_REASONING_MODEL || 'huihui_ai/qwen3.5-abliterated:35b',
    agentForgeTaskEndpoint: process.env.AGENTFORGE_TASK_ENDPOINT || `${dashboardUrl}/api/tasks`,
    agentForgeMemoryEndpoint: process.env.AGENTFORGE_MEMORY_ENDPOINT || `${dashboardUrl}/api/shared-memory`,
    agentForgeCrmEndpoint: process.env.AGENTFORGE_CRM_ENDPOINT || `${dashboardUrl}/api/crm`,
    agentForgeApprovalEndpoint: process.env.AGENTFORGE_APPROVAL_ENDPOINT || `${dashboardUrl}/api/approvals`,
    geminiGatewayEndpoint: process.env.GEMINI_GATEWAY_ENDPOINT || `${dashboardUrl}/api/agents/gemini`,
    webhookSharedSecret: process.env.WEBHOOK_SHARED_SECRET || process.env.JWT_SECRET || 'agentforge-dev',
  };
}

export type AnyInput = {
  name: string;
  type?: string;
  description?: string;
  value?: unknown;
  defaultValue?: unknown;
  url?: unknown;
};

export function findInput(spec: AutomationSpec, aliases: string[]): AnyInput | undefined {
  return (spec.inputs as AnyInput[]).find(input => {
    const name = input.name.toLowerCase();
    return aliases.some(alias => name.includes(alias.toLowerCase()));
  });
}

export function getInputString(
  spec: AutomationSpec,
  aliases: string[],
  fallback: string
): string {
  const input = findInput(spec, aliases);

  const raw =
    input?.value ??
    input?.defaultValue ??
    input?.url ??
    undefined;

  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }

  return fallback;
}

export function getInputArray(
  spec: AutomationSpec,
  aliases: string[],
  fallback: string[]
): string[] {
  const input = findInput(spec, aliases);

  const raw =
    input?.value ??
    input?.defaultValue ??
    undefined;

  if (Array.isArray(raw)) {
    return raw.map(String).map(v => v.trim()).filter(Boolean);
  }

  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
  }

  return fallback;
}

export function nodeId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function settings() {
  return {
    executionOrder: 'v1'
  };
}

export function telegramSendNode(name = 'Telegram Send', x = 700, y = 300) {
  const cfg = getN8nConfig();
  return {
    parameters: {
      chatId: cfg.telegramChatId,
      text: '={{ $json.telegramMessage }}',
      additionalFields: {
        parse_mode: 'Markdown'
      }
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1,
    position: [x, y]
  };
}

export function codeNode(name: string, jsCode: string, x: number, y: number) {
  return {
    parameters: {
      jsCode
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [x, y]
  };
}

export function ollamaChatNode(name = 'Ollama Chat', x = 700, y = 300, systemPrompt?: string) {
  const cfg = getN8nConfig();
  const jsonBody = systemPrompt
    ? `={{ JSON.stringify({ model: '${cfg.defaultLocalModel}', stream: false, messages: [{ role: 'system', content: '${systemPrompt.replace(/'/g, "\\'")}' }, { role: 'user', content: JSON.stringify($json).slice(0, 5000) }] }) }}`
    : '={{ JSON.stringify($json.ollamaRequest) }}';

  return {
    parameters: {
      method: 'POST',
      url: `${cfg.ollamaBaseUrl}/api/chat`,
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody,
      options: {}
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [x, y]
  };
}

export function agentForgePostNode(
  name: string,
  endpointExpression: string,
  x: number,
  y: number
) {
  return {
    parameters: {
      method: 'POST',
      url: endpointExpression,
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json) }}',
      options: {}
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [x, y]
  };
}
