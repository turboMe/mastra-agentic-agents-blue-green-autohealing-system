import { randomUUID } from 'crypto';

import { getDb } from '../lib/mongo.js';
import { logAgentEvent } from '../lib/agent-event-log.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { EMBEDDING_MODEL_ID, generateEmbedding } from '../lib/embedder.js';
import {
  buildSystemKnowledgeSearchText,
  hashSystemKnowledgeSearchText,
} from './memory-extractor.js';
import type {
  AutomationGoldenPathInput,
  AutomationGoldenPathResult,
  AutomationGoldenPathStep,
} from './automation-golden-path.js';

const KNOWLEDGE_TTL_DAYS = 90;

type RecordFailureInput = {
  input: AutomationGoldenPathInput;
  result: AutomationGoldenPathResult;
};

export async function recordAutomationGoldenPathFailure({
  input,
  result,
}: RecordFailureInput): Promise<void> {
  if (result.success) return;

  const now = new Date();
  const failedStep = findTerminalFailureStep(result.steps);
  const failureClass = classifyFailure(result, failedStep);
  const title = `Automation failure: ${failureClass} - ${truncate(result.message || result.error || 'blocked', 90)}`;
  const content = redactSecrets([
    `Agent: automationArchitect`,
    `Failure class: ${failureClass}`,
    `Status: ${result.status}`,
    `Mode: ${input.mode}`,
    input.patternId ? `Pattern: ${input.patternId}` : '',
    input.workflowName || result.workflowName ? `Workflow: ${input.workflowName ?? result.workflowName}` : '',
    `AutomationId: ${result.automationId}`,
    result.workflowId ? `WorkflowId: ${result.workflowId}` : '',
    `Message: ${result.message}`,
    result.error ? `Error: ${result.error}` : '',
    failedStep ? `Failed step: ${failedStep.name} (${failedStep.status}) - ${failedStep.message}` : '',
    `Repair attempts: ${result.repairAttempts}`,
    summarizeValidation(result),
    summarizeRisk(result),
    summarizeLastTest(result),
    summarizeRecovery(result),
    `Next-time guidance: ${recommendedNextStep(failureClass)}`,
  ].filter(Boolean).join('\n')).text;

  await Promise.allSettled([
    saveKnowledge({
      type: 'failure_case',
      title,
      content,
      confidence: 0.85,
      tags: ['automation', 'golden_path', failureClass, result.status],
    }),
    saveAutomationEvent(result.automationId, 'failure_case', {
      failureClass,
      status: result.status,
      message: result.message,
      failedStep,
      repairAttempts: result.repairAttempts,
    }),
    logAgentEvent({
      type: 'task_failed',
      agentId: 'automationArchitect',
      taskId: result.automationId,
      toolId: 'architect_execute_automation_request',
      status: 'error',
      input: summarizeInput(input),
      output: result.message,
      errorMessage: result.error ?? result.message,
      metadata: {
        failureClass,
        status: result.status,
        workflowId: result.workflowId,
        repairAttempts: result.repairAttempts,
      },
    }),
  ]);
}

export async function recordAutomationGoldenPathRecovery({
  input,
  result,
}: RecordFailureInput): Promise<void> {
  const recovered =
    result.success &&
    (result.repairAttempts > 0 ||
      ((result as any).recoveryStrategies ?? []).some((strategy: any) => strategy.outcome === 'succeeded'));
  if (!recovered) return;

  const content = redactSecrets([
    `Agent: automationArchitect`,
    `Status: ${result.status}`,
    `Mode: ${input.mode}`,
    input.patternId ? `Pattern: ${input.patternId}` : '',
    `AutomationId: ${result.automationId}`,
    result.workflowId ? `WorkflowId: ${result.workflowId}` : '',
    `Workflow: ${result.workflowName ?? input.workflowName ?? 'unknown'}`,
    `Repair attempts: ${result.repairAttempts}`,
    summarizeRecovery(result),
    `Reusable lesson: deterministic repair succeeded; prefer the same normalization/repair sequence before escalating to manual review.`,
  ].filter(Boolean).join('\n')).text;

  await Promise.allSettled([
    saveKnowledge({
      type: 'workflow_result',
      title: `Automation recovery: ${truncate(result.workflowName ?? input.workflowName ?? result.automationId, 90)}`,
      content,
      confidence: 0.75,
      tags: ['automation', 'golden_path', 'recovered'],
    }),
    logAgentEvent({
      type: 'retry_success',
      agentId: 'automationArchitect',
      taskId: result.automationId,
      toolId: 'architect_execute_automation_request',
      status: 'success',
      input: summarizeInput(input),
      output: result.message,
      metadata: {
        status: result.status,
        workflowId: result.workflowId,
        repairAttempts: result.repairAttempts,
      },
    }),
  ]);
}

async function saveKnowledge(input: {
  type: 'failure_case' | 'workflow_result';
  title: string;
  content: string;
  confidence: number;
  tags: string[];
}): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const storedContent = truncate(input.content, 1800);
  const searchText = buildSystemKnowledgeSearchText({
    type: input.type,
    title: input.title,
    content: storedContent,
    tags: input.tags,
    sourceAgent: 'automationArchitect',
  });
  const searchTextHash = hashSystemKnowledgeSearchText(searchText);
  let embedding: number[] = [];

  try {
    embedding = await generateEmbedding(searchText);
  } catch (error) {
    console.warn('[AutomationFailureLearning] Embedding failed:', (error as Error).message);
  }

  const existing = await db.collection('system_knowledge').findOne({
    type: input.type,
    title: input.title,
  });

  if (existing) {
    await db.collection('system_knowledge').updateOne(
      { knowledgeId: existing.knowledgeId },
      {
        $set: {
          content: storedContent,
          tags: input.tags,
          sourceAgent: 'automationArchitect',
          searchText,
          searchTextHash,
          embedding,
          embeddingModel: embedding.length > 0 ? EMBEDDING_MODEL_ID : undefined,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000),
          confidence: Math.min(1, (existing.confidence ?? input.confidence) + 0.05),
        },
      },
    );
    return;
  }

  await db.collection('system_knowledge').insertOne({
    knowledgeId: randomUUID(),
    type: input.type,
    title: input.title,
    content: storedContent,
    tags: input.tags,
    sourceAgent: 'automationArchitect',
    searchText,
    searchTextHash,
    embedding,
    embeddingModel: embedding.length > 0 ? EMBEDDING_MODEL_ID : undefined,
    sourceEventIds: [],
    confidence: input.confidence,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000),
  });
}

async function saveAutomationEvent(
  automationId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  await db.collection('automation_events').insertOne({
    automationId,
    type,
    data,
    createdAt: new Date(),
  });
}

function findTerminalFailureStep(steps: AutomationGoldenPathStep[]): AutomationGoldenPathStep | undefined {
  return [...steps].reverse().find((step) => step.status === 'failed' || step.status === 'blocked');
}

function classifyFailure(
  result: AutomationGoldenPathResult,
  failedStep?: AutomationGoldenPathStep,
): string {
  const text = [
    failedStep?.name,
    failedStep?.message,
    result.message,
    result.error,
  ].filter(Boolean).join('\n').toLowerCase();

  if (result.error) return 'exception';
  if (result.missingConfig && result.missingConfig.length > 0) return 'missing_config';
  if (result.validation?.securityIssues?.length) return 'security_validation';
  if (hasConnectionFailureSignal(result, text)) return 'connection_validation';
  if (result.validation?.errors?.length) return 'workflow_validation';
  if (result.risk?.verdict === 'block') return 'risk_blocked';
  if (result.risk?.verdict === 'review') return 'approval_required';
  if (result.lastTest?.status === 'failed') return 'mock_test_failed';
  if (/runtime|n8n|mongo|ollama|webhook/.test(text)) return 'runtime_blocked';
  return result.status;
}

function summarizeInput(input: AutomationGoldenPathInput): string {
  return JSON.stringify({
    mode: input.mode,
    request: input.request?.slice(0, 300),
    patternId: input.patternId,
    workflowName: input.workflowName,
    workflowId: input.workflowId,
    activate: input.activate,
    allowDraftWithMissingCredentials: input.allowDraftWithMissingCredentials,
  });
}

function summarizeValidation(result: AutomationGoldenPathResult): string {
  if (!result.validation) return '';
  return [
    `Validation: errors=${result.validation.errors.length}, securityIssues=${result.validation.securityIssues.length}, warnings=${result.validation.warnings.length}`,
    `Missing credentials=${result.validation.missingCredentials.length}, missing config=${result.validation.missingConfig.length}`,
    `Graph: triggers=${result.validation.triggerCount}, reachable=${result.validation.reachableNodeCount}, orphans=${result.validation.orphanNodeCount}, disconnectedComponents=${result.validation.disconnectedComponents.length}`,
  ].join('\n');
}

function summarizeRisk(result: AutomationGoldenPathResult): string {
  if (!result.risk) return '';
  return `Risk: score=${result.risk.score}, verdict=${result.risk.verdict}, findings=${result.risk.findings?.length ?? 0}`;
}

function summarizeLastTest(result: AutomationGoldenPathResult): string {
  if (!result.lastTest) return '';
  return `Last test: ${result.lastTest.mode}/${result.lastTest.status}, findings=${result.lastTest.findings.length}`;
}

function summarizeRecovery(result: AutomationGoldenPathResult): string {
  const strategies = ((result as any).recoveryStrategies ?? []) as Array<{
    name?: string;
    outcome?: string;
    reason?: string;
  }>;
  if (strategies.length === 0) return '';
  return [
    'Recovery strategies:',
    ...strategies.map((strategy) =>
      `- ${strategy.name ?? 'unknown'}: ${strategy.outcome ?? 'unknown'}${strategy.reason ? ` (${strategy.reason})` : ''}`,
    ),
  ].join('\n');
}

function recommendedNextStep(failureClass: string): string {
  switch (failureClass) {
    case 'missing_config':
    case 'runtime_blocked':
      return 'Verify runtime topology and required env vars before composing or deploying.';
    case 'workflow_validation':
    case 'security_validation':
      return 'Run deterministic draft repair before deploy and revalidate before touching n8n.';
    case 'connection_validation':
      return 'Run connection_id_to_name_repair first; if refs still do not match node.id or node.name, return manual_connection_mapping_required with missing source/target names.';
    case 'approval_required':
    case 'risk_blocked':
      return 'Do not bypass policy; request approval or redesign the workflow to lower risk.';
    case 'mock_test_failed':
      return 'Classify mock findings, apply bounded repair, redeploy inactive, and retest.';
    default:
      return 'Recall similar failure_case records before retrying the same automation shape.';
  }
}

function hasConnectionFailureSignal(result: AutomationGoldenPathResult, text: string): boolean {
  const strategies = ((result as any).recoveryStrategies ?? []) as Array<{ name?: string }>;
  if (strategies.some((strategy) => /connection_id_to_name_repair|connection_graph_repair|manual_connection_mapping_required/.test(strategy.name ?? ''))) {
    return true;
  }

  return /connection references unknown source|references unknown target|manual_connection_mapping_required|connection_graph_repair_required|not reachable|disconnected|trigger path/.test(text);
}

function truncate(text: string, max = 1000): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
