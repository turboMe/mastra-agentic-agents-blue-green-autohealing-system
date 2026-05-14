/**
 * Async Delegation Service
 *
 * Enables fire-and-forget delegation from meta-agent to coding-agent.
 * The coding-agent runs in the background, and results are queued as
 * pending messages for the meta-agent to pick up on the next user turn.
 *
 * Flow:
 *   meta-agent → delegateTask(async: true) → startAsyncDelegation()
 *   → coding-agent runs in background (via generateCoding)
 *   → result queued to pending_user_messages (scoped to meta-agent's threadId)
 *   → meta-agent's PendingUpdatesProcessor picks it up on next turn
 */

import { randomUUID } from 'crypto';
import type { Agent } from '@mastra/core/agent';

import { getDb } from '../lib/mongo.js';
import { logAgentEvent } from '../lib/agent-event-log.js';
import { generateCoding } from './coding-harness.js';
import { generateAutomation } from './automation-harness.js';
import { generateKnowledge } from './knowledge-harness.js';
import { queuePendingMessage } from './pending-message-queue.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type DelegationStatus = 'running' | 'completed' | 'failed';

export type DelegationRecord = {
  delegationId: string;
  targetAgent: string;
  taskDescription: string;
  /** Thread used by the coding-agent internally */
  agentThreadId: string;
  /** Thread of the meta-agent caller — results are delivered here */
  callerThreadId: string;
  /** Agent that should consume the pending result */
  callerAgentId?: string;
  originAgentId?: string;
  originThreadId?: string;
  targetAgentId?: string;
  targetThreadId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  status: DelegationStatus;
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
};

export type StartAsyncDelegationInput = {
  agent: Agent;
  agentId: string;
  prompt: string;
  /** Thread of the meta-agent — where to deliver results */
  callerThreadId: string;
  /** Agent that should consume pending results; defaults to meta-agent for backward compatibility */
  callerAgentId?: string;
  originAgentId?: string;
  originThreadId?: string;
  targetAgentId?: string;
  targetThreadId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  repoPath?: string;
  timeoutMs?: number;
};

// ── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = 'async_delegations';
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start an async delegation. Returns immediately with a delegationId.
 * The actual agent work happens in the background.
 */
export async function startAsyncDelegation(
  input: StartAsyncDelegationInput,
): Promise<{ delegationId: string }> {
  const delegationId = randomUUID();
  const agentThreadId = input.targetThreadId ?? `async-delegation-${delegationId}`;
  const now = new Date();
  const returnToAgentId = input.returnToAgentId ?? input.callerAgentId ?? 'meta-agent';
  const returnToThreadId = input.returnToThreadId ?? input.callerThreadId;

  const record: DelegationRecord = {
    delegationId,
    targetAgent: input.agentId,
    taskDescription: input.prompt.slice(0, 2000),
    agentThreadId,
    callerThreadId: input.callerThreadId,
    callerAgentId: input.callerAgentId ?? 'meta-agent',
    originAgentId: input.originAgentId ?? input.callerAgentId ?? 'meta-agent',
    originThreadId: input.originThreadId ?? input.callerThreadId,
    targetAgentId: input.targetAgentId ?? input.agentId,
    targetThreadId: agentThreadId,
    returnToAgentId,
    returnToThreadId,
    status: 'running',
    startedAt: now,
  };

  // Persist initial record to Mongo
  const db = await getDb();
  await db.collection<DelegationRecord>(COLLECTION).insertOne(record);

  logAgentEvent({
    type: 'delegation',
    agentId: input.agentId,
    status: 'pending',
    input: `[ASYNC] ${input.prompt.slice(0, 500)}`,
    metadata: { delegationId, async: true },
  });

  // Fire-and-forget — run target agent in background
  void executeDelegation(delegationId, agentThreadId, input);

  return { delegationId };
}

/**
 * Check the status of an async delegation.
 */
export async function getAsyncDelegation(
  delegationId: string,
): Promise<DelegationRecord | null> {
  const db = await getDb();
  return db.collection<DelegationRecord>(COLLECTION).findOne({ delegationId });
}

/**
 * List recent async delegations.
 */
export async function listAsyncDelegations(
  opts: { callerThreadId?: string; status?: DelegationStatus; limit?: number } = {},
): Promise<DelegationRecord[]> {
  const db = await getDb();
  const filter: Record<string, unknown> = {};
  if (opts.callerThreadId) filter.callerThreadId = opts.callerThreadId;
  if (opts.status) filter.status = opts.status;

  return db.collection<DelegationRecord>(COLLECTION)
    .find(filter)
    .sort({ startedAt: -1 })
    .limit(opts.limit ?? 10)
    .toArray();
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function executeDelegation(
  delegationId: string,
  agentThreadId: string,
  input: StartAsyncDelegationInput,
): Promise<void> {
  const start = Date.now();
  const db = await getDb();

  try {
    const delegatedPrompt = buildDelegatedPrompt(input);
    const harnessResult = input.agentId === 'automationArchitect'
      ? await generateAutomation({
          agent: input.agent,
          prompt: delegatedPrompt,
          threadId: agentThreadId,
          phase: 'chat',
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })
      : input.agentId === 'knowledgeAgent'
        ? await generateKnowledge({
            agent: input.agent,
            prompt: delegatedPrompt,
            threadId: agentThreadId,
            phase: 'chat',
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          })
        : await generateCoding({
          agent: input.agent,
          agentId: input.agentId,
          prompt: delegatedPrompt,
          threadId: agentThreadId,
          phase: 'chat',
          repoPath: input.repoPath ?? AGENTIC_AGENTS_REPO,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });

    const responseText = harnessResult.outputPreview ?? '';
    const durationMs = Date.now() - start;

    // Update delegation record
    await db.collection<DelegationRecord>(COLLECTION).updateOne(
      { delegationId },
      {
        $set: {
          status: 'completed' as DelegationStatus,
          result: responseText.slice(0, 5000),
          completedAt: new Date(),
          durationMs,
        },
      },
    );

    // Queue result as pending message for meta-agent's thread
    await queuePendingMessage({
      threadId: input.returnToThreadId ?? input.callerThreadId,
      targetAgentId: input.returnToAgentId ?? input.callerAgentId ?? 'meta-agent',
      source: 'background_task',
      content: [
        `## Async Delegation Result`,
        `**Agent:** ${input.agentId}`,
        `**Task:** ${input.prompt.slice(0, 200)}${input.prompt.length > 200 ? '...' : ''}`,
        `**Status:** ✅ completed (${(durationMs / 1000).toFixed(1)}s)`,
        `**Result:**`,
        responseText,
      ].join('\n'),
      urgent: false,
      metadata: {
        delegationId,
        agentId: input.agentId,
        durationMs,
        type: 'async_delegation_result',
        originAgentId: input.originAgentId ?? input.callerAgentId ?? 'meta-agent',
        originThreadId: input.originThreadId ?? input.callerThreadId,
        targetAgentId: input.targetAgentId ?? input.agentId,
        targetThreadId: agentThreadId,
        returnToAgentId: input.returnToAgentId ?? input.callerAgentId ?? 'meta-agent',
        returnToThreadId: input.returnToThreadId ?? input.callerThreadId,
      },
    });

    logAgentEvent({
      type: 'delegation',
      agentId: input.agentId,
      status: 'success',
      input: `[ASYNC COMPLETE] ${input.prompt.slice(0, 500)}`,
      output: responseText.slice(0, 500),
      durationMs,
      metadata: { delegationId, async: true },
    });

    console.log(`[AsyncDelegation] ✅ ${delegationId} completed in ${(durationMs / 1000).toFixed(1)}s`);
  } catch (error) {
    const durationMs = Date.now() - start;
    const err = error as Error;

    // Update delegation record
    await db.collection<DelegationRecord>(COLLECTION).updateOne(
      { delegationId },
      {
        $set: {
          status: 'failed' as DelegationStatus,
          error: err.message,
          completedAt: new Date(),
          durationMs,
        },
      },
    );

    // Queue error as pending message for meta-agent's thread
    await queuePendingMessage({
      threadId: input.returnToThreadId ?? input.callerThreadId,
      targetAgentId: input.returnToAgentId ?? input.callerAgentId ?? 'meta-agent',
      source: 'background_task',
      content: [
        `## Async Delegation Failed`,
        `**Agent:** ${input.agentId}`,
        `**Task:** ${input.prompt.slice(0, 200)}${input.prompt.length > 200 ? '...' : ''}`,
        `**Status:** ❌ failed (${(durationMs / 1000).toFixed(1)}s)`,
        `**Error:** ${err.message}`,
      ].join('\n'),
      urgent: true,
      metadata: {
        delegationId,
        agentId: input.agentId,
        durationMs,
        error: err.message,
        type: 'async_delegation_result',
        originAgentId: input.originAgentId ?? input.callerAgentId ?? 'meta-agent',
        originThreadId: input.originThreadId ?? input.callerThreadId,
        targetAgentId: input.targetAgentId ?? input.agentId,
        targetThreadId: agentThreadId,
        returnToAgentId: input.returnToAgentId ?? input.callerAgentId ?? 'meta-agent',
        returnToThreadId: input.returnToThreadId ?? input.callerThreadId,
      },
    });

    logAgentEvent({
      type: 'delegation',
      agentId: input.agentId,
      status: 'error',
      input: `[ASYNC FAILED] ${input.prompt.slice(0, 500)}`,
      errorMessage: err.message,
      durationMs,
      metadata: { delegationId, async: true },
    });

    console.warn(`[AsyncDelegation] ❌ ${delegationId} failed after ${(durationMs / 1000).toFixed(1)}s: ${err.message}`);
  }
}

function buildDelegatedPrompt(input: StartAsyncDelegationInput): string {
  const callerAgentId = input.callerAgentId ?? 'meta-agent';
  const returnToAgentId = input.returnToAgentId ?? callerAgentId;
  const returnToThreadId = input.returnToThreadId ?? input.callerThreadId;
  return [
    `SYSTEM DELEGATION CONTEXT: This task was delegated asynchronously by ${callerAgentId}.`,
    `originAgentId: ${input.originAgentId ?? callerAgentId}`,
    `originThreadId: ${input.originThreadId ?? input.callerThreadId}`,
    `targetAgentId: ${input.targetAgentId ?? input.agentId}`,
    `targetThreadId: ${input.targetThreadId ?? '(assigned by delegation service)'}`,
    `returnToAgentId: ${returnToAgentId}`,
    `returnToThreadId: ${returnToThreadId}`,
    'If you start durable background work, target completion notifications back to the caller when the result is needed after your response.',
    '',
    input.prompt,
  ].join('\n');
}
