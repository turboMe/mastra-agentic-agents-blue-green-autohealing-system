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
import { getDb } from '../lib/mongo.js';

import type { PendingMessage } from '../services/pending-message-queue.js';

// ── Thread ID extraction ─────────────────────────────────────────────────────

/**
 * Extract the threadId from the request context.
 * Mastra RequestContext stores threadId under 'mastra__threadId'.
 */
function extractThreadId(args: ProcessInputArgs): string | undefined {
  const rc = args.requestContext;
  if (rc) {
    try {
      // Mastra Studio uses RequestContext.get('mastra__threadId')
      const threadId = (rc as any).get?.('mastra__threadId');
      if (typeof threadId === 'string' && threadId.length > 0) return threadId;

      // Fallback: direct property access (older API)
      const rcAny = rc as unknown as Record<string, unknown>;
      const threadAlt = rcAny.threadId ?? rcAny.thread ?? rcAny['mastra__threadId'];
      if (typeof threadAlt === 'string' && threadAlt.length > 0) return threadAlt;
    } catch { /* safe — RC might not have .get() */ }
  }

  // Fallback: try to extract from the last user message metadata
  const lastUserMsg = [...args.messages].reverse().find((m) => m.role === 'user');
  if (lastUserMsg && typeof (lastUserMsg as any).threadId === 'string' && (lastUserMsg as any).threadId.length > 0) {
    return (lastUserMsg as any).threadId;
  }

  return undefined;
}

// ── Processor ────────────────────────────────────────────────────────────────

export class PendingUpdatesProcessor extends BaseProcessor<'pending-updates'> {
  readonly id = 'pending-updates' as const;
  readonly name = 'Pending Updates Processor';
  readonly description =
    'Checks for async delegation results and background task notifications before each meta-agent turn.';

  async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
    const { messages, systemMessages } = args;
    const threadId = extractThreadId(args);

    try {
      let pendingMessages: PendingMessage[];

      if (threadId) {
        // Primary: scoped to this thread
        pendingMessages = await takePendingMessages({
          threadId,
          agentId: 'meta-agent',
          limit: 5,
        });
      } else {
        // Fallback: Mastra Studio often has empty threadId in messages.
        // Query for ALL async_delegation_result pending messages and consume them.
        // This is safe because only meta-agent runs this processor.
        const db = await getDb();
        const now = new Date();
        const docs = await db.collection<PendingMessage>('pending_user_messages')
          .find({
            'metadata.type': 'async_delegation_result',
            status: 'pending',
            expiresAt: { $gt: now },
          })
          .sort({ urgent: -1, createdAt: 1 })
          .limit(5)
          .toArray();

        if (docs.length > 0) {
          // Mark as consumed
          await db.collection<PendingMessage>('pending_user_messages').updateMany(
            { id: { $in: docs.map((d) => d.id) }, status: 'pending' },
            { $set: { status: 'consumed', consumedAt: new Date(), consumedBy: 'meta-agent:pending-updates-processor' } },
          );
        }
        pendingMessages = docs;
      }

      if (pendingMessages.length === 0) {
        return messages;
      }

      const updateBlock = formatPendingMessagesForPrompt(pendingMessages);

      console.log(
        `[PendingUpdatesProcessor] Injected ${pendingMessages.length} pending update(s) for thread ${threadId ?? '(fallback)'}`,
      );

      // Inject updates as an additional system message so the agent sees them
      // before processing the user's message
      const injectedSystemMessage = {
        role: 'system' as const,
        content: [
          '## ⚡ Background Updates Available',
          'IMPORTANT: The following background task results arrived since your last response.',
          'You MUST acknowledge them at the beginning of your reply before addressing the user\'s question.',
          '',
          updateBlock,
          '',
          'After reporting these updates, proceed to address the user\'s current message.',
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

