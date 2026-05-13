import { randomUUID } from 'crypto';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { logHarnessEvent } from './harness-events.js';

export type ToolEnvelopeCategory =
  | 'file'
  | 'shell'
  | 'memory'
  | 'search'
  | 'git'
  | 'approval'
  | 'network'
  | 'other';

export type ToolEnvelopeRisk = 'low' | 'medium' | 'high';
export type ToolExecutionStatus = 'started' | 'completed' | 'failed' | 'blocked';

export type ToolEnvelopeMetadata = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  runId?: string;
  turnId?: string;
};

export type ToolExecutionDoc = ToolEnvelopeMetadata & {
  id: string;
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  status: ToolExecutionStatus;
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
  durationMs?: number;
  errorClass?: string;
  errorMessage?: string;
  fileActivityIds?: string[];
  createdAt: Date;
  completedAt?: Date;
  expiresAt: Date;
};

type ToolEnvelopeConfig<TInput, TOutput> = {
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  defaultAgentId?: string;
  redactInputFields?: string[];
  inputPreviewMaxChars?: number;
  outputPreviewMaxChars?: number;
  metadata?: (input: TInput) => ToolEnvelopeMetadata;
  execute: (input: TInput) => Promise<TOutput>;
};

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_PREVIEW_CHARS = 1000;

export function withToolEnvelope<TInput, TOutput>(
  config: ToolEnvelopeConfig<TInput, TOutput>,
): (input: TInput) => Promise<TOutput> {
  return async (input: TInput): Promise<TOutput> => {
    if (!isHarnessFeatureEnabled('FEATURE_TOOL_ENVELOPE', true)) {
      return config.execute(input);
    }

    const startedAt = Date.now();
    const executionId = randomUUID();
    const metadata = {
      ...extractToolMetadata(input),
      ...(config.metadata?.(input) ?? {}),
    };
    const agentId = metadata.agentId ?? config.defaultAgentId ?? 'codingAgent';
    const runId = metadata.runId ?? metadata.taskId;
    const inputPreview = buildToolPreview(input, {
      redactFields: config.redactInputFields,
      maxChars: config.inputPreviewMaxChars ?? DEFAULT_PREVIEW_CHARS,
    });

    await recordToolStarted({
      id: executionId,
      metadata: { ...metadata, agentId, runId },
      toolId: config.toolId,
      category: config.category,
      risk: config.risk,
      inputPreview,
    });

    try {
      const output = await config.execute(input);
      const durationMs = Date.now() - startedAt;
      const outputPreview = buildToolPreview(output, {
        maxChars: config.outputPreviewMaxChars ?? DEFAULT_PREVIEW_CHARS,
      });
      const outputArtifactId = extractOutputArtifactId(output);
      const success = isSuccessfulToolOutput(output);
      const errorMessage = success ? undefined : extractOutputErrorMessage(output);
      const errorClass = success ? undefined : classifyToolError({
        category: config.category,
        output,
        errorMessage,
      });
      const status: ToolExecutionStatus = success
        ? 'completed'
        : errorClass === 'policy_blocked' || errorClass === 'approval_required'
          ? 'blocked'
          : 'failed';

      await recordToolFinished({
        id: executionId,
        metadata: { ...metadata, agentId, runId },
        toolId: config.toolId,
        category: config.category,
        risk: config.risk,
        status,
        inputPreview,
        outputPreview,
        outputArtifactId,
        durationMs,
        errorClass,
        errorMessage,
      });

      return output;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const err = error as Error;
      const errorClass = classifyThrownToolError(err);

      await recordToolFinished({
        id: executionId,
        metadata: { ...metadata, agentId, runId },
        toolId: config.toolId,
        category: config.category,
        risk: config.risk,
        status: errorClass === 'policy_blocked' || errorClass === 'approval_required' ? 'blocked' : 'failed',
        inputPreview,
        durationMs,
        errorClass,
        errorMessage: err.message,
      });

      throw error;
    }
  };
}

export function buildToolPreview(
  value: unknown,
  options: { redactFields?: string[]; maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_PREVIEW_CHARS;
  const redactedFieldSet = new Set((options.redactFields ?? []).map((field) => field.toLowerCase()));
  let serialized = '';

  try {
    serialized = typeof value === 'string'
      ? value
      : JSON.stringify(redactStructuredValue(value, redactedFieldSet));
  } catch {
    serialized = String(value);
  }

  const safeText = redactSecrets(serialized).text;
  return truncate(safeText, maxChars);
}

export function classifyToolError(input: {
  category: ToolEnvelopeCategory;
  output?: unknown;
  errorMessage?: string;
}): string {
  const text = [
    input.errorMessage,
    extractOutputText(input.output),
  ].filter(Boolean).join('\n').toLowerCase();

  if (/approval/.test(text)) return 'approval_required';
  if (/allowlist|not allowed|policy|blocked/.test(text)) return 'policy_blocked';
  if (/timeout|timed out|etimedout/.test(text)) return 'timeout';
  if (/validation|invalid|required|wymagan/.test(text)) return 'validation';
  if (input.category === 'shell' && hasNonZeroExitCode(input.output)) return 'command_failed';
  if (/exit code|test zwrocil bledy|command failed|failed/.test(text)) return 'command_failed';
  if (/conflict|konflikt/.test(text)) return 'file_conflict';
  return 'unknown';
}

function classifyThrownToolError(error: Error): string {
  const message = error.message.toLowerCase();
  if (/approval/.test(message)) return 'approval_required';
  if (/allowlist|not allowed|policy|blocked/.test(message)) return 'policy_blocked';
  if (/timeout|timed out|etimedout/.test(message)) return 'timeout';
  if (/validation|invalid|required|wymagan/.test(message)) return 'validation';
  if (/conflict|konflikt/.test(message)) return 'file_conflict';
  return error.name || 'unknown';
}

function extractToolMetadata(input: unknown): ToolEnvelopeMetadata {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  return {
    taskId: stringValue(record.taskId),
    subtaskId: stringValue(record.subtaskId),
    agentId: stringValue(record.agentId),
    threadId: stringValue(record.threadId),
    runId: stringValue(record.runId),
    turnId: stringValue(record.turnId),
  };
}

function redactStructuredValue(value: unknown, redactedFields: Set<string>, depth = 0): unknown {
  if (depth > 6) return '[Max depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value, 4000);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => redactStructuredValue(entry, redactedFields, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (redactedFields.has(key.toLowerCase())) {
      out[key] = typeof entry === 'string'
        ? `[redacted:${entry.length} chars]`
        : '[redacted]';
    } else {
      out[key] = redactStructuredValue(entry, redactedFields, depth + 1);
    }
  }
  return out;
}

function isSuccessfulToolOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object') return true;
  const success = (output as Record<string, unknown>).success;
  return success !== false;
}

function extractOutputErrorMessage(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const record = output as Record<string, unknown>;
  return stringValue(record.error) ?? stringValue(record.message);
}

function extractOutputText(output: unknown): string | undefined {
  if (!output) return undefined;
  if (typeof output === 'string') return output;
  if (typeof output !== 'object') return String(output);
  const record = output as Record<string, unknown>;
  return [
    stringValue(record.error),
    stringValue(record.message),
    stringValue(record.output),
  ].filter(Boolean).join('\n');
}

function hasNonZeroExitCode(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const exitCode = (output as Record<string, unknown>).exitCode;
  return typeof exitCode === 'number' && exitCode !== 0;
}

function extractOutputArtifactId(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const record = output as Record<string, unknown>;
  return stringValue(record.outputArtifactId) ?? stringValue(record.fullTextArtifactId);
}

async function recordToolStarted(input: {
  id: string;
  metadata: ToolEnvelopeMetadata & { agentId: string };
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  inputPreview?: string;
}): Promise<void> {
  const now = new Date();
  const doc: ToolExecutionDoc = {
    id: input.id,
    ...input.metadata,
    toolId: input.toolId,
    category: input.category,
    risk: input.risk,
    status: 'started',
    inputPreview: input.inputPreview,
    createdAt: now,
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
  };

  await insertToolExecution(doc);
  await logHarnessEvent({
    type: 'tool_call_started',
    agentId: input.metadata.agentId,
    runId: input.metadata.runId,
    turnId: input.metadata.turnId,
    threadId: input.metadata.threadId,
    taskId: input.metadata.taskId,
    subtaskId: input.metadata.subtaskId,
    feature: 'tool_envelope',
    toolId: input.toolId,
    status: 'pending',
    input: input.inputPreview,
    data: {
      executionId: input.id,
      category: input.category,
      risk: input.risk,
    },
  });
}

async function recordToolFinished(input: {
  id: string;
  metadata: ToolEnvelopeMetadata & { agentId: string };
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  status: ToolExecutionStatus;
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
  durationMs: number;
  errorClass?: string;
  errorMessage?: string;
}): Promise<void> {
  const completedAt = new Date();
  await updateToolExecution({
    id: input.id,
    metadata: input.metadata,
    toolId: input.toolId,
    category: input.category,
    risk: input.risk,
    status: input.status,
    inputPreview: input.inputPreview,
    outputPreview: input.outputPreview,
    outputArtifactId: input.outputArtifactId,
    durationMs: input.durationMs,
    errorClass: input.errorClass,
    errorMessage: input.errorMessage,
    completedAt,
  });

  await logHarnessEvent({
    type: input.status === 'completed' ? 'tool_call_completed' : 'tool_call_failed',
    agentId: input.metadata.agentId,
    runId: input.metadata.runId,
    turnId: input.metadata.turnId,
    threadId: input.metadata.threadId,
    taskId: input.metadata.taskId,
    subtaskId: input.metadata.subtaskId,
    feature: 'tool_envelope',
    toolId: input.toolId,
    status: input.status === 'completed' ? 'success' : 'error',
    output: input.outputPreview,
    errorMessage: input.errorMessage,
    durationMs: input.durationMs,
    data: {
      executionId: input.id,
      category: input.category,
      risk: input.risk,
      toolStatus: input.status,
      errorClass: input.errorClass,
      outputArtifactId: input.outputArtifactId,
    },
  });
}

async function insertToolExecution(doc: ToolExecutionDoc): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<ToolExecutionDoc>('tool_executions').insertOne(doc);
  } catch (error) {
    console.warn('[ToolEnvelope] Failed to insert tool execution:', (error as Error).message);
  }
}

async function updateToolExecution(input: {
  id: string;
  metadata: ToolEnvelopeMetadata & { agentId: string };
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  status: ToolExecutionStatus;
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
  durationMs: number;
  errorClass?: string;
  errorMessage?: string;
  completedAt: Date;
}): Promise<void> {
  try {
    const db = await getDb();
    const set: Partial<ToolExecutionDoc> = {
      status: input.status,
      outputPreview: input.outputPreview,
      outputArtifactId: input.outputArtifactId,
      durationMs: input.durationMs,
      errorClass: input.errorClass,
      errorMessage: input.errorMessage,
      completedAt: input.completedAt,
    };

    await db.collection<ToolExecutionDoc>('tool_executions').updateOne(
      { id: input.id },
      {
        $setOnInsert: {
          id: input.id,
          ...input.metadata,
          toolId: input.toolId,
          category: input.category,
          risk: input.risk,
          inputPreview: input.inputPreview,
          createdAt: input.completedAt,
          expiresAt: new Date(input.completedAt.getTime() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
        },
        $set: set,
      },
      { upsert: true },
    );
  } catch (error) {
    console.warn('[ToolEnvelope] Failed to update tool execution:', (error as Error).message);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
