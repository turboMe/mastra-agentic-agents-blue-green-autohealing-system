/**
 * Telegram Bot Tools (Phase F5.1)
 *
 * Provides agent-accessible tools for sending messages and alerts
 * via Telegram Bot API. Used by ErrorCollector for critical alerts
 * and by agents for user notifications.
 *
 * Requires: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
 *
 * API Reference: https://core.telegram.org/bots/api
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ── Internal ─────────────────────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

async function telegramRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<TelegramResponse> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN nie jest ustawiony w .env');

  const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await response.json()) as TelegramResponse;
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
  }
  return data;
}

function getDefaultChatId(): string {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID nie jest ustawiony w .env');
  return chatId;
}

// ── Tools ────────────────────────────────────────────────────────────────────

export const telegramSendMessageTool = createTool({
  id: 'telegram_send_message',
  description:
    'Wysyła wiadomość tekstową przez Telegram bota. Używaj do powiadomień, ' +
    'alertów o błędach, raportów statusu. Obsługuje Markdown formatting.',
  inputSchema: z.object({
    text: z.string().describe('Treść wiadomości (obsługuje MarkdownV2)'),
    chatId: z
      .string()
      .optional()
      .describe('Telegram chat ID. Domyślnie używa TELEGRAM_CHAT_ID z env.'),
    parseMode: z
      .enum(['MarkdownV2', 'HTML', 'Markdown'])
      .optional()
      .default('MarkdownV2')
      .describe('Tryb formatowania tekstu'),
    silent: z
      .boolean()
      .optional()
      .default(false)
      .describe('Wyślij bez powiadomienia dźwiękowego'),
  }),
  execute: async (context) => {
    try {
      const chatId = context.chatId || getDefaultChatId();

      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: context.text,
        parse_mode: context.parseMode ?? 'MarkdownV2',
        disable_notification: context.silent ?? false,
      });

      return { success: true, chatId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const telegramSendAlertTool = createTool({
  id: 'telegram_send_alert',
  description:
    'Wysyła sformatowany alert o krytycznym zdarzeniu przez Telegram. ' +
    'Używaj gdy ErrorCollector wykryje powtarzający się błąd lub system wymaga uwagi.',
  inputSchema: z.object({
    title: z.string().describe('Tytuł alertu (np. "Build Failed", "Memory Leak")'),
    details: z.string().describe('Szczegóły zdarzenia'),
    severity: z
      .enum(['critical', 'warning', 'info'])
      .default('warning')
      .describe('Poziom ważności'),
    source: z.string().optional().describe('Źródło alertu (np. "ErrorCollector", "GpuGuard")'),
  }),
  execute: async (context) => {
    try {
      const chatId = getDefaultChatId();

      const severityIcon: Record<string, string> = {
        critical: '🔴',
        warning: '🟡',
        info: '🔵',
      };
      const icon = severityIcon[context.severity ?? 'info'] ?? '🔵';

      const message = [
        `${icon} *${escapeMarkdownV2(context.title)}*`,
        '',
        escapeMarkdownV2(context.details),
        '',
        context.source ? `_Source: ${escapeMarkdownV2(context.source)}_` : '',
        `_${escapeMarkdownV2(new Date().toISOString())}_`,
      ]
        .filter(Boolean)
        .join('\n');

      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: message,
        parse_mode: 'MarkdownV2',
        disable_notification: context.severity === 'info',
      });

      return { success: true, severity: context.severity };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const telegramSendDocumentTool = createTool({
  id: 'telegram_send_document',
  description:
    'Wysyła plik/dokument przez Telegram bota. Przydatne do wysyłania ' +
    'raportów, logów, screenshotów.',
  inputSchema: z.object({
    fileUrl: z.string().describe('URL pliku do wysłania'),
    caption: z.string().optional().describe('Podpis pod plikiem'),
    chatId: z.string().optional().describe('Telegram chat ID'),
  }),
  execute: async (context) => {
    try {
      const chatId = context.chatId || getDefaultChatId();

      await telegramRequest('sendDocument', {
        chat_id: chatId,
        document: context.fileUrl,
        caption: context.caption,
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape special characters for Telegram MarkdownV2.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
