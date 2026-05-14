/**
 * Check Pending Updates Tool
 *
 * Allows meta-agent to poll for async delegation results and background
 * task completions. Returns pending updates if any are available.
 *
 * This replaces the InputProcessor approach which doesn't work reliably
 * because the Mastra processor pipeline can fail on OM threadId checks.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';

type PendingDoc = {
  id: string;
  threadId?: string;
  targetAgentId?: string | null;
  source: string;
  content: string;
  urgent: boolean;
  status: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
};

export const checkPendingUpdatesTool = createTool({
  id: 'checkPendingUpdates',
  description:
    'Check for completed background tasks and async delegation results. ' +
    'Call this FIRST at the start of every conversation turn to see if there are any pending updates from background processes. ' +
    'If results are available, report them to the user before answering their question.',
  inputSchema: z.object({
    agentId: z.enum(['meta-agent', 'automationArchitect', 'codingAgent']).optional().default('meta-agent'),
    threadId: z.string().optional().describe('Optional thread scope. Use when you know the active Mastra thread id.'),
  }),
  outputSchema: z.object({
    hasUpdates: z.boolean(),
    updates: z.array(z.object({
      source: z.string(),
      content: z.string(),
      urgent: z.boolean(),
      type: z.string().optional(),
    })),
    message: z.string(),
  }),

  execute: async (input) => {
    try {
      const db = await getDb();
      const now = new Date();
      const agentId = input.agentId ?? 'meta-agent';
      const targetQuery = {
        $or: [
          { targetAgentId: agentId },
          { targetAgentId: { $exists: false } },
          { targetAgentId: null },
        ],
      };
      const scopedQuery = input.threadId
        ? { $and: [{ threadId: input.threadId }, targetQuery] }
        : targetQuery;

      const docs = await db.collection<PendingDoc>('pending_user_messages')
        .find({
          ...scopedQuery,
          status: 'pending',
          source: { $in: ['background_task', 'automation_job'] },
          expiresAt: { $gt: now },
        })
        .sort({ urgent: -1, createdAt: 1 })
        .limit(5)
        .toArray();

      if (docs.length === 0) {
        return {
          hasUpdates: false,
          updates: [],
          message: 'No pending background updates.',
        };
      }

      // Mark as consumed
      const ids = docs.map((d) => d.id);
      await db.collection<PendingDoc>('pending_user_messages').updateMany(
        { id: { $in: ids }, status: 'pending' },
        {
          $set: {
            status: 'consumed',
            consumedAt: new Date(),
            consumedBy: `${agentId}:checkPendingUpdatesTool`,
          },
        },
      );

      console.log(`[checkPendingUpdates] Delivered ${docs.length} update(s) to ${agentId}`);

      const updates = docs.map((d) => ({
        source: d.source,
        content: d.content,
        urgent: d.urgent,
        type: (d.metadata as Record<string, unknown>)?.type as string ?? 'background_task',
      }));

      return {
        hasUpdates: true,
        updates,
        message: `${docs.length} background update(s) available. Report these to the user.`,
      };
    } catch (error) {
      console.warn('[checkPendingUpdates] Error:', (error as Error).message);
      return {
        hasUpdates: false,
        updates: [],
        message: `Error checking updates: ${(error as Error).message}`,
      };
    }
  },
});
