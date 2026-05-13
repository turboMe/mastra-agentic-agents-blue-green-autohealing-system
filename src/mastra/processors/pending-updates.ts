/**
 * Pending Updates Input Processor for Meta-Agent
 *
 * Runs at processInput (once per generate/stream call) to check for
 * pending messages from async delegations, background tasks, and system
 * notifications. Injects them as a system context block so the meta-agent
 * naturally surfaces updates in its response.
 *
 * Etap Harness — Async Delegation Layer
 */

import type { ProcessInputArgs, ProcessInputResult } from '@mastra/core/processors';
import { BaseProcessor } from '@mastra/core/processors';
import { takePendingMessages, formatPendingMessagesForPrompt } from '../services/pending-message-queue.js';

/**
 * Extract the threadId from the request context.
 * Mastra passes memory thread info through requestContext.
 */
function extractThreadId(args: ProcessInputArgs): string | undefined {
  // Try to get threadId from requestContext (Mastra Studio passes it)
  const rc = args.requestContext;
  if (rc) {
    const rcAny = rc as unknown as Record<string, unknown>;
    const threadId = rcAny.threadId ?? rcAny.thread;
    if (typeof threadId === 'string') return threadId;
  }

  // Fallback: try to extract from the last user message metadata
  const lastUserMsg = [...args.messages].reverse().find((m) => m.role === 'user');
  if (lastUserMsg && typeof lastUserMsg.threadId === 'string') {
    return lastUserMsg.threadId;
  }

  return undefined;
}

export class PendingUpdatesProcessor extends BaseProcessor<'pending-updates'> {
  readonly id = 'pending-updates' as const;
  readonly name = 'Pending Updates Processor';
  readonly description =
    'Checks for async delegation results and background task notifications before each meta-agent turn.';

  async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
    const { messages, messageList, systemMessages } = args;
    const threadId = extractThreadId(args);

    if (!threadId) {
      // No threadId — can't scope the query, skip
      return messages;
    }

    try {
      const pendingMessages = await takePendingMessages({
        threadId,
        agentId: 'meta-agent',
        limit: 5,
      });

      if (pendingMessages.length === 0) {
        return messages;
      }

      const updateBlock = formatPendingMessagesForPrompt(pendingMessages);

      console.log(
        `[PendingUpdatesProcessor] Injected ${pendingMessages.length} pending update(s) for thread ${threadId}`,
      );

      // Inject updates as an additional system message so the agent sees them
      // before processing the user's message
      const injectedSystemMessage = {
        role: 'system' as const,
        content: [
          '## Background Updates Available',
          'The following updates arrived since your last response. Acknowledge them naturally in your reply:',
          '',
          updateBlock,
          '',
          'After acknowledging, proceed to address the user\'s current message.',
        ].join('\n'),
      };

      return {
        messages,
        systemMessages: [...systemMessages, injectedSystemMessage],
      };
    } catch (error) {
      // Non-fatal — processor must not crash the agent
      console.warn('[PendingUpdatesProcessor] Failed to check pending messages:', (error as Error).message);
      return messages;
    }
  }
}

export const pendingUpdatesProcessor = new PendingUpdatesProcessor();
