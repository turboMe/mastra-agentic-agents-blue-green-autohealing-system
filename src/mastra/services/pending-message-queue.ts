/**
 * Pending message queue for safe soft interrupts.
 *
 * Messages are only consumed at safe points: before a subtask/group, retry, or
 * escalation. Nothing here attempts to inject into an active provider stream.
 */

import { randomUUID } from 'crypto';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { logHarnessEvent } from './harness-events.js';

export type PendingMessageSource = 'user' | 'system' | 'file_activity' | 'background_task';
export type PendingMessageStatus = 'pending' | 'consumed' | 'cancelled' | 'stale';

export type PendingMessage = {
  id: string;
  taskId?: string;
  threadId?: string;
  targetAgentId?: string;
  source: PendingMessageSource;
  content: string;
  urgent: boolean;
  status: PendingMessageStatus;
  createdAt: Date;
  consumedAt?: Date;
  consumedBy?: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
};

export type QueuePendingMessageInput = {
  taskId?: string;
  threadId?: string;
  targetAgentId?: string;
  source: PendingMessageSource;
  content: string;
  urgent?: boolean;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
};

export type TakePendingMessagesInput = {
  taskId?: string;
  threadId?: string;
  agentId?: string;
  subtaskId?: string;
  limit?: number;
};

const COLLECTION = 'pending_user_messages';
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const DEFAULT_LIMIT = 5;

export async function queuePendingMessage(input: QueuePendingMessageInput): Promise<string | undefined> {
  if (!isHarnessFeatureEnabled('FEATURE_SOFT_INTERRUPTS', true)) return undefined;
  if (!input.taskId && !input.threadId) return undefined;

  const content = redactSecrets(input.content.trim()).text;
  if (!content) return undefined;

  const id = randomUUID();
  const now = new Date();
  const doc: PendingMessage = {
    id,
    taskId: input.taskId,
    threadId: input.threadId,
    targetAgentId: input.targetAgentId,
    source: input.source,
    content,
    urgent: Boolean(input.urgent),
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
    metadata: input.metadata,
  };

  try {
    const db = await getDb();
    await db.collection<PendingMessage>(COLLECTION).insertOne(doc);
    await logHarnessEvent({
      type: 'soft_interrupt_queued',
      agentId: input.targetAgentId ?? 'codingAgent',
      threadId: input.threadId,
      taskId: input.taskId,
      feature: 'pending_message_queue',
      status: 'success',
      output: content,
      data: {
        messageId: id,
        source: doc.source,
        urgent: doc.urgent,
        metadata: input.metadata,
      },
    });
    return id;
  } catch (error) {
    console.warn('[PendingMessageQueue] queue failed:', (error as Error).message);
    return undefined;
  }
}

export async function takePendingMessages(input: TakePendingMessagesInput): Promise<PendingMessage[]> {
  if (!isHarnessFeatureEnabled('FEATURE_SOFT_INTERRUPTS', true)) return [];
  if (!input.taskId && !input.threadId) return [];

  try {
    const db = await getDb();
    const now = new Date();
    const messages = await db.collection<PendingMessage>(COLLECTION)
      .find({
        ...scopedTargetQuery(input),
        status: 'pending',
        expiresAt: { $gt: now },
      })
      .sort({ urgent: -1, createdAt: 1 })
      .limit(input.limit ?? DEFAULT_LIMIT)
      .toArray();

    if (messages.length === 0) return [];

    await markConsumed(messages.map((message) => message.id), {
      agentId: input.agentId,
      subtaskId: input.subtaskId,
    });

    for (const message of messages) {
      await logHarnessEvent({
        type: 'soft_interrupt_consumed',
        agentId: input.agentId ?? 'codingAgent',
        threadId: message.threadId ?? input.threadId,
        taskId: message.taskId ?? input.taskId,
        subtaskId: input.subtaskId,
        feature: 'pending_message_queue',
        status: 'success',
        output: message.content,
        data: {
          messageId: message.id,
          source: message.source,
          urgent: message.urgent,
        },
      });
    }

    return messages;
  } catch (error) {
    console.warn('[PendingMessageQueue] take failed:', (error as Error).message);
    return [];
  }
}

export async function hasUrgentInterrupt(input: Pick<TakePendingMessagesInput, 'taskId' | 'threadId'>): Promise<boolean> {
  if (!isHarnessFeatureEnabled('FEATURE_SOFT_INTERRUPTS', true)) return false;
  if (!input.taskId && !input.threadId) return false;

  try {
    const db = await getDb();
    const found = await db.collection<PendingMessage>(COLLECTION).findOne({
      ...scopeQuery(input),
      status: 'pending',
      urgent: true,
      expiresAt: { $gt: new Date() },
    });
    return Boolean(found);
  } catch (error) {
    console.warn('[PendingMessageQueue] urgent lookup failed:', (error as Error).message);
    return false;
  }
}

export async function markConsumed(
  ids: string[],
  input: { agentId?: string; subtaskId?: string } = {},
): Promise<void> {
  if (ids.length === 0) return;

  const db = await getDb();
  await db.collection<PendingMessage>(COLLECTION).updateMany(
    { id: { $in: ids }, status: 'pending' },
    {
      $set: {
        status: 'consumed',
        consumedAt: new Date(),
        consumedBy: [input.agentId, input.subtaskId].filter(Boolean).join(':') || undefined,
      },
    },
  );
}

export function formatPendingMessagesForPrompt(messages: PendingMessage[]): string {
  if (messages.length === 0) return '';

  const urgent = messages.some((message) => message.urgent);
  const header = urgent
    ? '## User/System Interrupt\nUrgent instruction received at a safe interrupt point:'
    : '## User/System Interrupt\nPending instruction received at a safe interrupt point:';

  const body = messages.map((message, index) => {
    const label = message.urgent ? 'URGENT' : message.source;
    return `${index + 1}. [${label}] ${message.content}`;
  });

  return [
    header,
    ...body,
    urgent
      ? 'Re-evaluate the remaining plan before continuing. Do not ignore this instruction.'
      : 'Apply this instruction if it is relevant to the current subtask.',
  ].join('\n');
}

function scopeQuery(input: Pick<TakePendingMessagesInput, 'taskId' | 'threadId'>): Record<string, unknown> {
  const clauses: Record<string, string>[] = [];
  if (input.taskId) clauses.push({ taskId: input.taskId });
  if (input.threadId) clauses.push({ threadId: input.threadId });
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function targetAgentQuery(agentId?: string): Record<string, unknown> {
  if (!agentId) return {};
  return {
    $or: [
      { targetAgentId: agentId },
      { targetAgentId: { $exists: false } },
      { targetAgentId: null },
    ],
  };
}

function scopedTargetQuery(input: TakePendingMessagesInput): Record<string, unknown> {
  const scope = scopeQuery(input);
  const target = targetAgentQuery(input.agentId);
  if (Object.keys(target).length === 0) return scope;
  return { $and: [scope, target] };
}
