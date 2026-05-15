/**
 * Pending Updates Input Processor
 *
 * Runs at processInput (once per generate/stream call) to check for
 * pending messages from async delegations, background tasks, and system
 * notifications. Injects them as a system context block so the target agent
 * naturally surfaces updates in its response.
 *
 * Etap Harness — Async Delegation Layer
 */

import type { ProcessInputArgs, ProcessInputResult } from '@mastra/core/processors';
import { BaseProcessor } from '@mastra/core/processors';
import { takePendingMessages, formatPendingMessagesForPrompt } from '../services/pending-message-queue.js';
import { getDb } from '../lib/mongo.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  META_AGENT_ID,
  canonicalizeRuntimeAgentId,
  pendingTargetAgentQuery,
} from '../config/agent-ids.js';

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
    'Checks for async delegation results and background task notifications before each agent turn.';

  constructor(
    private readonly options: {
      agentId?: string;
      maxUpdates?: number;
    } = {},
  ) {
    super();
  }

  async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
    const { messages, systemMessages } = args;
    const threadId = extractThreadId(args);
    const agentId = canonicalizeRuntimeAgentId(this.options.agentId) ?? META_AGENT_ID;
    const limit = this.options.maxUpdates ?? 5;

    console.log(`[PendingUpdatesProcessor] ▶ processInput called. agentId=${agentId}, threadId=${threadId ?? '(none)'}, messages=${messages.length}`);

    try {
      let pendingMessages: PendingMessage[];

      if (threadId) {
        console.log(`[PendingUpdatesProcessor] Using scoped query: threadId=${threadId}`);
        pendingMessages = await takePendingMessages({
          threadId,
          agentId,
          limit,
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
            source: { $in: ['background_task', 'automation_job'] },
            ...pendingTargetAgentQuery(agentId),
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
            { $set: { status: 'consumed' as const, consumedAt: new Date(), consumedBy: `${agentId}:pending-updates-processor` } },
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
export const automationPendingUpdatesProcessor = new PendingUpdatesProcessor({
  agentId: AUTOMATION_ARCHITECT_AGENT_ID,
});
export const knowledgePendingUpdatesProcessor = new PendingUpdatesProcessor({
  agentId: KNOWLEDGE_AGENT_ID,
});
