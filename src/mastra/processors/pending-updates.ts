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

function extractThreadId(args: ProcessInputArgs): string | undefined {
  const rc = args.requestContext;
  if (rc) {
    try {
      const threadId = (rc as any).get?.('mastra__threadId');
      if (typeof threadId === 'string' && threadId.length > 0) return threadId;

      const rcAny = rc as unknown as Record<string, unknown>;
      const threadAlt = rcAny.threadId ?? rcAny.thread ?? rcAny['mastra__threadId'];
      if (typeof threadAlt === 'string' && threadAlt.length > 0) return threadAlt;
    } catch { /* safe */ }
  }

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

    console.log(`[PendingUpdatesProcessor] ▶ processInput called. threadId=${threadId ?? '(none)'}, messages=${messages.length}`);

    try {
      let pendingMessages: PendingMessage[];

      if (threadId) {
        console.log(`[PendingUpdatesProcessor] Using scoped query: threadId=${threadId}`);
        pendingMessages = await takePendingMessages({
          threadId,
          agentId: 'meta-agent',
          limit: 5,
        });
      } else {
        // Fallback: query ALL undelivered pending messages broadly.
        // This covers both async_delegation_result AND regular background_task messages.
        console.log('[PendingUpdatesProcessor] No threadId — using fallback (global pending query)');
        const db = await getDb();
        const now = new Date();
        const docs = await db.collection<PendingMessage>('pending_user_messages')
          .find({
            status: 'pending',
            source: 'background_task',
            expiresAt: { $gt: now },
          })
          .sort({ urgent: -1, createdAt: 1 })
          .limit(5)
          .toArray();

        console.log(`[PendingUpdatesProcessor] Fallback query found ${docs.length} pending message(s)`);

        if (docs.length > 0) {
          const ids = docs.map((d) => d.id);
          await db.collection<PendingMessage>('pending_user_messages').updateMany(
            { id: { $in: ids }, status: 'pending' },
            { $set: { status: 'consumed' as const, consumedAt: new Date(), consumedBy: 'meta-agent:pending-updates-processor' } },
          );
          console.log(`[PendingUpdatesProcessor] Marked ${ids.length} message(s) as consumed`);
        }
        pendingMessages = docs;
      }

      if (pendingMessages.length === 0) {
        console.log('[PendingUpdatesProcessor] No pending messages found — passing through');
        return messages;
      }

      const updateBlock = formatPendingMessagesForPrompt(pendingMessages);

      console.log(
        `[PendingUpdatesProcessor] ✅ Injecting ${pendingMessages.length} pending update(s) into system messages`,
      );

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
      console.error('[PendingUpdatesProcessor] ❌ ERROR:', (error as Error).message, (error as Error).stack);
      return messages;
    }
  }
}

export const pendingUpdatesProcessor = new PendingUpdatesProcessor();


