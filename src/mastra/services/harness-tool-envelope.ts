import { randomUUID } from 'crypto';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { logHarnessEvent } from './harness-events.js';
import { evaluateAndLogHarnessPolicy } from './harness-policy.js';
import type { HarnessPolicyDecision, HarnessPolicyRequest } from './harness-policy.js';

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
  policyDecision?: ToolExecutionPolicySummary | ToolExecutionPolicySummary[];
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

export type ToolExecutionPolicySummary = Pick<
  HarnessPolicyDecision,
  | 'id'
  | 'allow'
  | 'effectiveAllow'
  | 'requiresApproval'
  | 'severity'
  | 'reason'
  | 'approvalType'
  | 'matchedRule'
  | 'enforcementMode'
  | 'enforced'
>;

type ToolEnvelopeConfig<TInput, TOutput> = {
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  defaultAgentId?: string;
  redactInputFields?: string[];
  inputPreviewMaxChars?: number;
  outputPreviewMaxChars?: number;
  metadata?: (input: TInput) => ToolEnvelopeMetadata;
  policy?: (
    input: TInput,
    metadata: ToolEnvelopeMetadata & { agentId: string; runId?: string },
  ) =>
    | HarnessPolicyRequest
    | HarnessPolicyRequest[]
    | undefined
    | Promise<HarnessPolicyRequest | HarnessPolicyRequest[] | undefined>;
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
    const policyDecision = await evaluateToolPolicy(config, input, { ...metadata, agentId, runId });

    await recordToolStarted({
      id: executionId,
      metadata: { ...metadata, agentId, runId },
      toolId: config.toolId,
      category: config.category,
      risk: config.risk,
      policyDecision,
      inputPreview,
    });

    try {
      if (hasEnforcedPolicyBlock(policyDecision)) {
        const blocked = firstBlockedPolicyDecision(policyDecision);
        throw new Error(blocked?.reason ?? `Policy blocked tool execution: ${config.toolId}`);
      }

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
        policyDecision,
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
      const policyBlocked = hasEnforcedPolicyBlock(policyDecision);
      const errorClass = policyBlocked ? 'policy_blocked' : classifyThrownToolError(err);

      await recordToolFinished({
        id: executionId,
        metadata: { ...metadata, agentId, runId },
        toolId: config.toolId,
        category: config.category,
        risk: config.risk,
        status: policyBlocked || errorClass === 'approval_required' ? 'blocked' : 'failed',
        policyDecision,
        inputPreview,
        durationMs,
        errorClass,
        errorMessage: err.message,
      });

      throw error;
    }
  };
}

async function evaluateToolPolicy<TInput, TOutput>(
  config: ToolEnvelopeConfig<TInput, TOutput>,
  input: TInput,
  metadata: ToolEnvelopeMetadata & { agentId: string; runId?: string },
): Promise<ToolExecutionPolicySummary | ToolExecutionPolicySummary[] | undefined> {
  if (!config.policy) return undefined;

  const requestOrRequests = await config.policy(input, metadata);
  if (!requestOrRequests) return undefined;

  const requests = Array.isArray(requestOrRequests) ? requestOrRequests : [requestOrRequests];
  const decisions = await Promise.all(
    requests.map((request) =>
      evaluateAndLogHarnessPolicy({
        ...request,
        agentId: request.agentId ?? metadata.agentId,
        runId: request.runId ?? metadata.runId,
        turnId: request.turnId ?? metadata.turnId,
        threadId: request.threadId ?? metadata.threadId,
        taskId: request.taskId ?? metadata.taskId,
        subtaskId: request.subtaskId ?? metadata.subtaskId,
        toolId: request.toolId ?? config.toolId,
        riskHint: request.riskHint ?? config.risk,
      }),
    ),
  );

  const summaries = decisions.map(toPolicySummary);
  return summaries.length === 1 ? summaries[0] : summaries;
}

function toPolicySummary(decision: HarnessPolicyDecision): ToolExecutionPolicySummary {
  return {
    id: decision.id,
    allow: decision.allow,
    effectiveAllow: decision.effectiveAllow,
    requiresApproval: decision.requiresApproval,
    severity: decision.severity,
    reason: decision.reason,
    approvalType: decision.approvalType,
    matchedRule: decision.matchedRule,
    enforcementMode: decision.enforcementMode,
    enforced: decision.enforced,
  };
}

function hasEnforcedPolicyBlock(
  decision: ToolExecutionPolicySummary | ToolExecutionPolicySummary[] | undefined,
): boolean {
  return Boolean(firstBlockedPolicyDecision(decision));
}

function firstBlockedPolicyDecision(
  decision: ToolExecutionPolicySummary | ToolExecutionPolicySummary[] | undefined,
): ToolExecutionPolicySummary | undefined {
  if (!decision) return undefined;
  const decisions = Array.isArray(decision) ? decision : [decision];
  return decisions.find((entry) => !entry.effectiveAllow);
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
  policyDecision?: ToolExecutionPolicySummary | ToolExecutionPolicySummary[];
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
    policyDecision: input.policyDecision,
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
      policyDecision: input.policyDecision,
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
  policyDecision?: ToolExecutionPolicySummary | ToolExecutionPolicySummary[];
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
    policyDecision: input.policyDecision,
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
      policyDecision: input.policyDecision,
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
  policyDecision?: ToolExecutionPolicySummary | ToolExecutionPolicySummary[];
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
      policyDecision: input.policyDecision,
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

// ── Post-hoc workspace tool logging ──────────────────────────────────────
// Workspace tools from @mastra/core bypass withToolEnvelope. This function
// logs them after execution via the onStepFinish hook in coding-harness.

const WORKSPACE_TOOL_META: Record<string, { category: ToolEnvelopeCategory; risk: ToolEnvelopeRisk }> = {
  view: { category: 'file', risk: 'low' },
  write_file: { category: 'file', risk: 'medium' },
  find_files: { category: 'file', risk: 'low' },
  search_content: { category: 'search', risk: 'low' },
  workspace_search: { category: 'search', risk: 'low' },
  index_content: { category: 'search', risk: 'low' },
  lsp_inspect: { category: 'other', risk: 'low' },
  execute_command: { category: 'shell', risk: 'medium' },
  mastra_workspace_read_file: { category: 'file', risk: 'low' },
  mastra_workspace_write_file: { category: 'file', risk: 'medium' },
  mastra_workspace_list_files: { category: 'file', risk: 'low' },
  mastra_workspace_grep: { category: 'search', risk: 'low' },
  mastra_workspace_execute_command: { category: 'shell', risk: 'medium' },
  mastra_workspace_search: { category: 'search', risk: 'low' },
};

type PolicyAction = import('./harness-policy.js').HarnessPolicyAction;

function mapToolToPolicyAction(toolId: string): PolicyAction | undefined {
  if (toolId === 'view' || toolId === 'mastra_workspace_read_file') return 'read_file';
  if (toolId === 'write_file' || toolId === 'mastra_workspace_write_file') return 'write_file';
  if (toolId === 'execute_command' || toolId === 'mastra_workspace_execute_command') return 'run_command';
  return undefined;
}

export function isWorkspaceTool(toolName: string): boolean {
  return toolName in WORKSPACE_TOOL_META;
}

export async function logPostHocToolExecution(input: {
  toolCallId: string;
  toolId: string;
  args: unknown;
  result: unknown;
  isError?: boolean;
  agentId: string;
  runId?: string;
  turnId?: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
}): Promise<void> {
  if (!isHarnessFeatureEnabled('FEATURE_TOOL_ENVELOPE', true)) return;

  const executionId = randomUUID();
  const now = new Date();
  const meta = WORKSPACE_TOOL_META[input.toolId] ?? { category: 'other' as const, risk: 'low' as const };
  const inputPreview = buildToolPreview(input.args, { maxChars: DEFAULT_PREVIEW_CHARS });
  const outputPreview = buildToolPreview(input.result, { maxChars: DEFAULT_PREVIEW_CHARS });
  const status: ToolExecutionStatus = input.isError ? 'failed' : 'completed';

  // Policy evaluation (post-hoc / log-only — tool already executed)
  let policyDecision: ToolExecutionPolicySummary | undefined;
  const policyAction = mapToolToPolicyAction(input.toolId);
  if (policyAction) {
    const args = (input.args && typeof input.args === 'object') ? input.args as Record<string, unknown> : {};
    const decision = await evaluateAndLogHarnessPolicy({
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      toolId: input.toolId,
      action: policyAction,
      target: stringValue(args.path) ?? stringValue(args.filePath),
      command: stringValue(args.command),
      riskHint: meta.risk,
    });
    policyDecision = toPolicySummary(decision);
  }

  const doc: ToolExecutionDoc = {
    id: executionId,
    agentId: input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    toolId: input.toolId,
    category: meta.category,
    risk: meta.risk,
    status,
    policyDecision,
    inputPreview,
    outputPreview,
    createdAt: now,
    completedAt: now,
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
  };

  await insertToolExecution(doc);
  await logHarnessEvent({
    type: status === 'completed' ? 'tool_call_completed' : 'tool_call_failed',
    agentId: input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: 'tool_envelope',
    toolId: input.toolId,
    status: status === 'completed' ? 'success' : 'error',
    input: inputPreview,
    output: outputPreview,
    data: {
      executionId,
      category: meta.category,
      risk: meta.risk,
      toolStatus: status,
      policyDecision,
      postHoc: true,
    },
  });
}
