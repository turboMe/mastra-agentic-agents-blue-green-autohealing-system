/**
 * Webhook Sender Tool (Phase F5.5)
 *
 * Generic webhook tool for sending structured payloads to
 * Slack, Discord, n8n, Make.com, Zapier, or any HTTP endpoint.
 * Supports POST/PUT with JSON body and custom headers.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const webhookSendTool = createTool({
  id: 'webhook.send',
  description:
    'Wysyła payload JSON do dowolnego webhook URL (Slack, Discord, n8n, Make, Zapier). ' +
    'Używaj do integracji z zewnętrznymi systemami powiadomień i automatyzacji.',
  inputSchema: z.object({
    url: z.string().url().describe('Webhook URL docelowy'),
    payload: z.record(z.string(), z.unknown()).describe('Payload JSON do wysłania'),
    method: z
      .enum(['POST', 'PUT'])
      .optional()
      .default('POST')
      .describe('Metoda HTTP'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Dodatkowe nagłówki HTTP (np. Authorization)'),
    timeoutMs: z
      .number()
      .optional()
      .default(10_000)
      .describe('Timeout w milisekundach'),
  }),
  execute: async (context) => {
    try {
      const response = await fetch(context.url, {
        method: context.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(context.headers ?? {}),
        },
        body: JSON.stringify(context.payload),
        signal: AbortSignal.timeout(context.timeoutMs ?? 10_000),
      });

      const status = response.status;
      let responseBody: string;
      try {
        responseBody = await response.text();
        if (responseBody.length > 1000) {
          responseBody = responseBody.slice(0, 1000) + '…';
        }
      } catch {
        responseBody = '(no body)';
      }

      return {
        success: response.ok,
        status,
        response: responseBody,
      };
    } catch (error) {
      return {
        success: false,
        status: 0,
        error: (error as Error).message,
      };
    }
  },
});

// ── Preset: Slack Webhook ────────────────────────────────────────────────────

export const slackWebhookTool = createTool({
  id: 'webhook.slack',
  description:
    'Wysyła wiadomość do kanału Slack przez Incoming Webhook. ' +
    'Wymaga SLACK_WEBHOOK_URL w .env.',
  inputSchema: z.object({
    text: z.string().describe('Treść wiadomości (Slack mrkdwn format)'),
    channel: z.string().optional().describe('Override kanału (np. #alerts)'),
    username: z.string().optional().default('Mastra Bot').describe('Nazwa bota'),
    iconEmoji: z.string().optional().default(':robot_face:').describe('Emoji ikona bota'),
  }),
  execute: async (context) => {
    try {
      const url = process.env.SLACK_WEBHOOK_URL;
      if (!url) throw new Error('SLACK_WEBHOOK_URL nie jest ustawiony w .env');

      const payload: Record<string, unknown> = {
        text: context.text,
        username: context.username ?? 'Mastra Bot',
        icon_emoji: context.iconEmoji ?? ':robot_face:',
      };
      if (context.channel) payload.channel = context.channel;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      return { success: response.ok, status: response.status };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ── Preset: Discord Webhook ──────────────────────────────────────────────────

export const discordWebhookTool = createTool({
  id: 'webhook.discord',
  description:
    'Wysyła wiadomość do kanału Discord przez Webhook URL. ' +
    'Wymaga DISCORD_WEBHOOK_URL w .env.',
  inputSchema: z.object({
    content: z.string().describe('Treść wiadomości (Discord markdown)'),
    username: z.string().optional().default('Mastra Bot').describe('Nazwa bota'),
    embeds: z
      .array(
        z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          color: z.number().optional().describe('Kolor embeda (decimal, np. 16711680 = red)'),
        }),
      )
      .optional()
      .describe('Discord embeds (opcjonalne rich formatting)'),
  }),
  execute: async (context) => {
    try {
      const url = process.env.DISCORD_WEBHOOK_URL;
      if (!url) throw new Error('DISCORD_WEBHOOK_URL nie jest ustawiony w .env');

      const payload: Record<string, unknown> = {
        content: context.content,
        username: context.username ?? 'Mastra Bot',
      };
      if (context.embeds) payload.embeds = context.embeds;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      return { success: response.ok, status: response.status };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
