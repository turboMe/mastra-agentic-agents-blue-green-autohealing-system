/**
 * Durable Automation Golden Path jobs.
 *
 * This runs Golden Path in the Mastra process instead of shelling out through
 * bg_task. It persists state, stores a compact result preview, and wakes the
 * right agent/thread when the job completes.
 */

import { randomUUID } from 'crypto';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { logHarnessEvent } from './harness-events.js';
import { compactHarnessOutput } from './harness-output-compactor.js';
import { queuePendingMessage } from './pending-message-queue.js';
import {
  executeAutomationGoldenPath,
  type AutomationGoldenPathInput,
  type AutomationGoldenPathResult,
} from './automation-golden-path.js';

export type AutomationJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

export type AutomationJobRecord = {
  jobId: string;
  automationId: string;
  targetAgentId: string;
  callerAgentId?: string;
  callerThreadId?: string;
  architectThreadId?: string;
  originAgentId?: string;
  originThreadId?: string;
  targetThreadId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  status: AutomationJobStatus;
  inputPreview: string;
  resultPreview?: string;
  resultArtifactId?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeatAt: Date;
  expiresAt: Date;
  runId?: string;
  turnId?: string;
};

export type StartAutomationJobInput = {
  input: AutomationGoldenPathInput;
  automationId?: string;
  targetAgentId?: string;
  callerAgentId?: string;
  callerThreadId?: string;
  architectThreadId?: string;
  originAgentId?: string;
  originThreadId?: string;
  targetThreadId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  wake?: boolean;
  ttlMs?: number;
  runId?: string;
  turnId?: string;
};

export type ListAutomationJobsFilter = {
  automationId?: string;
  targetAgentId?: string;
  returnToAgentId?: string;
  status?: AutomationJobStatus;
  limit?: number;
};

const COLLECTION = 'automation_jobs';
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 15 * 60 * 1000;

const liveJobs = new Map<string, { cancelled: boolean; heartbeat?: ReturnType<typeof setInterval> }>();

export async function startAutomationJob(
  input: StartAutomationJobInput,
): Promise<AutomationJobRecord> {
  if (!isHarnessFeatureEnabled('FEATURE_BACKGROUND_TASKS', true)) {
    throw new Error('Automation jobs are disabled because FEATURE_BACKGROUND_TASKS=false');
  }

  const jobId = randomUUID();
  const automationId = input.automationId ?? input.input.automationId ?? randomUUID();
  const now = new Date();
  const goldenPathInput: AutomationGoldenPathInput = {
    ...input.input,
    automationId,
  };
  const returnToAgentId = input.returnToAgentId ?? input.targetAgentId ?? 'automationArchitect';
  const targetAgentId = input.targetAgentId ?? returnToAgentId;

  const record: AutomationJobRecord = {
    jobId,
    automationId,
    targetAgentId,
    callerAgentId: input.callerAgentId,
    callerThreadId: input.callerThreadId,
    architectThreadId: input.architectThreadId,
    originAgentId: input.originAgentId ?? input.callerAgentId,
    originThreadId: input.originThreadId ?? input.callerThreadId,
    targetThreadId: input.targetThreadId ?? input.architectThreadId,
    returnToAgentId,
    returnToThreadId: input.returnToThreadId ?? input.callerThreadId ?? input.architectThreadId,
    status: 'queued',
    inputPreview: previewAutomationInput(goldenPathInput),
    startedAt: now,
    lastHeartbeatAt: now,
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
    runId: input.runId,
    turnId: input.turnId,
  };

  const db = await getDb();
  await db.collection<AutomationJobRecord>(COLLECTION).insertOne(record);

  await logHarnessEvent({
    type: 'bg_task_started',
    agentId: targetAgentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: record.returnToThreadId,
    taskId: jobId,
    feature: 'automation_jobs',
    status: 'success',
    output: `Automation job started: ${jobId}`,
    data: {
      jobId,
      automationId,
      targetAgentId,
      returnToAgentId,
      returnToThreadId: record.returnToThreadId,
    },
  });

  void executeAutomationJob(jobId, goldenPathInput, { ...record, wake: input.wake ?? true });

  return record;
}

export async function getAutomationJob(jobId: string): Promise<AutomationJobRecord | null> {
  const db = await getDb();
  return db.collection<AutomationJobRecord>(COLLECTION).findOne({ jobId });
}

export async function listAutomationJobs(
  filter: ListAutomationJobsFilter = {},
): Promise<AutomationJobRecord[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};
  if (filter.automationId) query.automationId = filter.automationId;
  if (filter.targetAgentId) query.targetAgentId = filter.targetAgentId;
  if (filter.returnToAgentId) query.returnToAgentId = filter.returnToAgentId;
  if (filter.status) query.status = filter.status;

  return db.collection<AutomationJobRecord>(COLLECTION)
    .find(query)
    .sort({ startedAt: -1 })
    .limit(filter.limit ?? 20)
    .toArray();
}

export async function cancelAutomationJob(jobId: string): Promise<boolean> {
  const db = await getDb();
  const record = await getAutomationJob(jobId);
  if (!record || !['queued', 'running'].includes(record.status)) return false;

  const live = liveJobs.get(jobId);
  if (live) live.cancelled = true;

  const now = new Date();
  await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
    { jobId, status: { $in: ['queued', 'running'] } },
    {
      $set: {
        status: 'cancelled' as AutomationJobStatus,
        completedAt: now,
        lastHeartbeatAt: now,
      },
    },
  );

  await logHarnessEvent({
    type: 'bg_task_completed',
    agentId: record.targetAgentId,
    runId: record.runId,
    turnId: record.turnId,
    threadId: record.returnToThreadId,
    taskId: jobId,
    feature: 'automation_jobs',
    status: 'success',
    output: `Automation job cancelled: ${jobId}`,
    data: { jobId, automationId: record.automationId, status: 'cancelled' },
  });

  return true;
}

export async function markStaleAutomationJobs(
  opts: { staleAfterMs?: number } = {},
): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - (opts.staleAfterMs ?? STALE_AFTER_MS));
  const result = await db.collection<AutomationJobRecord>(COLLECTION).updateMany(
    {
      status: { $in: ['queued', 'running'] },
      lastHeartbeatAt: { $lt: cutoff },
    },
    {
      $set: {
        status: 'stale' as AutomationJobStatus,
        completedAt: new Date(),
      },
    },
  );
  return result.modifiedCount;
}

async function executeAutomationJob(
  jobId: string,
  input: AutomationGoldenPathInput,
  routing: AutomationJobRecord & { wake: boolean },
): Promise<void> {
  const db = await getDb();
  const live = { cancelled: false, heartbeat: undefined as ReturnType<typeof setInterval> | undefined };
  liveJobs.set(jobId, live);

  const heartbeat = async () => {
    await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
      { jobId, status: 'running' },
      { $set: { lastHeartbeatAt: new Date() } },
    ).catch(() => undefined);
  };

  try {
    const runningUpdate = await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
      { jobId, status: 'queued' },
      {
        $set: {
          status: 'running' as AutomationJobStatus,
          lastHeartbeatAt: new Date(),
        },
      },
    );
    if (runningUpdate.matchedCount === 0) return;
    live.heartbeat = setInterval(() => void heartbeat(), HEARTBEAT_MS);

    if (live.cancelled) return;

    const result = await executeAutomationGoldenPath(input);
    const current = await getAutomationJob(jobId);
    if (live.cancelled || current?.status === 'cancelled') return;

    const compacted = await compactHarnessOutput({
      text: JSON.stringify(result, null, 2),
      kind: 'tool_output',
      runId: routing.runId,
      turnId: routing.turnId,
      threadId: routing.returnToThreadId,
      taskId: jobId,
      agentId: routing.targetAgentId,
      toolId: 'automation_job_manager',
      previewBytes: 4000,
      metadata: {
        scope: 'automation_job_result',
        jobId,
        automationId: result.automationId,
        workflowId: result.workflowId,
      },
    });
    const resultPreview = buildResultPreview(result, compacted.preview);
    const now = new Date();

    await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
      { jobId },
      {
        $set: {
          status: 'completed' as AutomationJobStatus,
          resultPreview,
          resultArtifactId: compacted.fullTextArtifactId,
          completedAt: now,
          lastHeartbeatAt: now,
        },
      },
    );

    if (routing.wake) {
      await queueAutomationJobResult({
        routing,
        jobId,
        result,
        resultPreview,
        artifactId: compacted.fullTextArtifactId,
      });
    }

    await logHarnessEvent({
      type: 'bg_task_completed',
      agentId: routing.targetAgentId,
      runId: routing.runId,
      turnId: routing.turnId,
      threadId: routing.returnToThreadId,
      taskId: jobId,
      feature: 'automation_jobs',
      status: result.success ? 'success' : 'error',
      output: resultPreview,
      data: {
        jobId,
        automationId: result.automationId,
        workflowId: result.workflowId,
        goldenPathStatus: result.status,
        success: result.success,
      },
    });
  } catch (error) {
    const err = error as Error;
    const current = await getAutomationJob(jobId);
    if (current?.status === 'cancelled') return;

    const now = new Date();
    await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
      { jobId },
      {
        $set: {
          status: 'failed' as AutomationJobStatus,
          error: err.message,
          completedAt: now,
          lastHeartbeatAt: now,
        },
      },
    );

    if (routing.wake) {
      await queuePendingMessage({
        taskId: jobId,
        threadId: routing.returnToThreadId,
        targetAgentId: routing.returnToAgentId ?? routing.targetAgentId,
        source: 'automation_job',
        urgent: true,
        content: [
          '## Automation Job Failed',
          `Job ID: ${jobId}`,
          `Automation ID: ${routing.automationId}`,
          `Error: ${err.message}`,
        ].join('\n'),
        metadata: {
          type: 'automation_job_result',
          jobId,
          automationId: routing.automationId,
          status: 'failed',
          error: err.message,
          returnToAgentId: routing.returnToAgentId,
          returnToThreadId: routing.returnToThreadId,
        },
      });
    }

    await logHarnessEvent({
      type: 'bg_task_completed',
      agentId: routing.targetAgentId,
      runId: routing.runId,
      turnId: routing.turnId,
      threadId: routing.returnToThreadId,
      taskId: jobId,
      feature: 'automation_jobs',
      status: 'error',
      errorMessage: err.message,
      output: `Automation job failed: ${jobId}`,
      data: { jobId, automationId: routing.automationId },
    });
  } finally {
    if (live.heartbeat) clearInterval(live.heartbeat);
    liveJobs.delete(jobId);
  }
}

async function queueAutomationJobResult(input: {
  routing: AutomationJobRecord;
  jobId: string;
  result: AutomationGoldenPathResult;
  resultPreview: string;
  artifactId?: string;
}): Promise<void> {
  const { routing, jobId, result, resultPreview, artifactId } = input;
  await queuePendingMessage({
    taskId: jobId,
    threadId: routing.returnToThreadId,
    targetAgentId: routing.returnToAgentId ?? routing.targetAgentId,
    source: 'automation_job',
    urgent: !result.success,
    content: [
      '## Automation Job Result',
      `Job ID: ${jobId}`,
      `Automation ID: ${result.automationId}`,
      result.workflowId ? `Workflow ID: ${result.workflowId}` : '',
      result.workflowName ? `Workflow: ${result.workflowName}` : '',
      `Golden Path status: ${result.status}`,
      `Success: ${result.success}`,
      `Message: ${result.message}`,
      result.risk ? `Risk: ${result.risk.verdict} (${result.risk.score})` : '',
      result.lastTest ? `Last test: ${result.lastTest.status}` : '',
      `Repair attempts: ${result.repairAttempts}`,
      artifactId ? `Full result artifact: ${artifactId}` : '',
      '',
      resultPreview,
    ].filter(Boolean).join('\n'),
    metadata: {
      type: 'automation_job_result',
      jobId,
      automationId: result.automationId,
      workflowId: result.workflowId,
      status: result.status,
      success: result.success,
      resultArtifactId: artifactId,
      originAgentId: routing.originAgentId,
      originThreadId: routing.originThreadId,
      returnToAgentId: routing.returnToAgentId,
      returnToThreadId: routing.returnToThreadId,
    },
  });
}

function previewAutomationInput(input: AutomationGoldenPathInput): string {
  return redactSecrets(JSON.stringify({
    mode: input.mode,
    request: input.request,
    patternId: input.patternId,
    workflowName: input.workflowName,
    workflowId: input.workflowId,
    automationId: input.automationId,
    activate: input.activate,
    allowDraftWithMissingCredentials: input.allowDraftWithMissingCredentials,
    requiresPublicWebhook: input.requiresPublicWebhook,
    spec: input.spec ? {
      id: input.spec.id,
      requestId: input.spec.requestId,
      name: input.spec.name,
      triggerType: input.spec.trigger?.type,
      externalServices: input.spec.externalServices,
      credentialsNeeded: input.spec.credentialsNeeded?.map((credential) => ({
        service: credential.service,
        required: credential.required,
      })),
      riskLevel: input.spec.riskLevel,
    } : undefined,
    workflow: input.workflow ? summarizeWorkflow(input.workflow) : undefined,
    workflowFilePath: input.workflowFilePath,
    approvalToken: input.approvalToken ? '[REDACTED]' : undefined,
  }, null, 2)).text.slice(0, 2000);
}

function buildResultPreview(result: AutomationGoldenPathResult, compactedPreview: string): string {
  const summary = [
    `status=${result.status}`,
    `success=${result.success}`,
    `automationId=${result.automationId}`,
    result.workflowId ? `workflowId=${result.workflowId}` : '',
    result.workflowName ? `workflowName=${result.workflowName}` : '',
    result.risk ? `risk=${result.risk.verdict}:${result.risk.score}` : '',
    result.lastTest ? `lastTest=${result.lastTest.status}` : '',
    `repairAttempts=${result.repairAttempts}`,
    `message=${result.message}`,
  ].filter(Boolean).join('\n');
  return [summary, '', compactedPreview].join('\n').slice(0, 5000);
}

function summarizeWorkflow(workflow: unknown): Record<string, unknown> {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return { type: typeof workflow };
  }
  const record = workflow as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  return {
    name: record.name,
    active: record.active,
    nodeCount: nodes.length,
    connectionCount: record.connections && typeof record.connections === 'object'
      ? Object.keys(record.connections as Record<string, unknown>).length
      : 0,
    nodeTypes: nodes
      .map((node) => node && typeof node === 'object' ? (node as Record<string, unknown>).type : undefined)
      .filter(Boolean)
      .slice(0, 12),
  };
}
