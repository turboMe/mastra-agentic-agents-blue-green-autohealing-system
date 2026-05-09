/**
 * Subtask Executor (Etap 8.2 + 8.3a)
 *
 * Executes individual coding subtasks via scoped prompts with model-specific
 * routing. Includes quality validation and intelligent retry/escalation:
 *
 *   Attempt 1 → quality check → fail → RETRY (same model, enriched prompt)
 *   Attempt 2 → quality check → fail → ESCALATE (stronger model)
 *   Attempt 3 → quality check → fail → mark 'needs_human'
 */

import { randomUUID } from 'crypto';

import type { Mastra } from '@mastra/core/mastra';
import type { Agent } from '@mastra/core/agent';
import {
  type ModelCapability,
  type TaskComplexity,
  modelRegistry,
  complexityMeetsRequirement,
} from '../config/model-capabilities.js';
import type { RoutableSubtask, RoutingResult } from './smart-router.js';
import { getDb } from '../lib/mongo.js';
import { logAgentEvent } from '../lib/agent-event-log.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubtaskResult {
  subtaskId: string;
  status: 'success' | 'partial' | 'failed' | 'skipped' | 'needs_human';
  assignedModel: string;
  actualModel?: string;
  filesChanged: Array<{ path: string; summary: string }>;
  commandsRun: Array<{ command: string; exitCode: number; summary: string }>;
  diagnostics: string;
  errors: string[];
  durationMs: number;
  tokenUsage?: { prompt: number; completion: number };
  qualityCheck?: {
    passed: boolean;
    reason: string;
    attempt: number;
    escalationHistory: Array<{ model: string; reason: string }>;
  };
}

export interface SubtaskContext {
  taskId: string;
  previousResults: SubtaskResult[];
  retryContext?: SubtaskResult;
}

// ── Quality Signals ──────────────────────────────────────────────────────────

export type QualitySignal =
  | 'no_files_changed'
  | 'tsc_errors'
  | 'target_files_missed'
  | 'agent_reported_failure'
  | 'empty_diagnostics'
  | 'partial_completion';

export interface QualityValidation {
  passed: boolean;
  reason: string;
  signals: QualitySignal[];
}

// ── Escalation Path ──────────────────────────────────────────────────────────

const ESCALATION_PATH: Record<string, string[]> = {
  'local-micro':  ['local-light', 'local-heavy', 'cloud-fast', 'cloud-pro'],
  'local-light':  ['local-heavy', 'cloud-fast', 'cloud-pro'],
  'local-heavy':  ['cloud-fast', 'cloud-pro'],
  'cloud-fast':   ['cloud-pro'],
  'cloud-pro':    [],
};

const MAX_RETRY_ATTEMPTS = 3;

// ── Timeouts by Complexity ───────────────────────────────────────────────────

const COMPLEXITY_TIMEOUTS: Record<string, number> = {
  trivial: 30_000,
  simple: 60_000,
  moderate: 120_000,
  complex: 300_000,
};

/**
 * Execute a single subtask with scoped prompt and model routing.
 * Includes offline fallback: cloud error → local, local error → cloud.
 */
export async function executeSubtask(
  subtask: RoutableSubtask,
  taskId: string,
  context: SubtaskContext,
  mastra: Mastra,
  _fallbackAttempt = 0,
): Promise<SubtaskResult> {
  const startTime = Date.now();
  const modelId = subtask.assignedModel!;

  // Build scope-constrained prompt for this subtask
  const prompt = context.retryContext
    ? buildRetryPrompt(subtask, context.retryContext, taskId, context)
    : buildSubtaskPrompt(subtask, taskId, context);

  const agent = mastra.getAgent('codingAgent');
  const timeoutMs = COMPLEXITY_TIMEOUTS[subtask.estimatedComplexity ?? 'simple'] ?? 60_000;

  try {
    // Execute with timeout
    const response = await Promise.race([
      agent.generate(prompt, { model: modelId } as any),
      createTimeout(timeoutMs, `Subtask ${subtask.id} timed out after ${timeoutMs / 1000}s`),
    ]);

    // Collect results from artifact in Mongo
    const collectedResult = await collectSubtaskResult(taskId, subtask.id);

    return {
      subtaskId: subtask.id,
      status: collectedResult.hasErrors ? 'partial' : 'success',
      assignedModel: modelId,
      filesChanged: collectedResult.filesChanged,
      commandsRun: collectedResult.commandsRun,
      diagnostics: extractDiagnostics(response),
      errors: collectedResult.errors,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errMsg = (error as Error).message ?? '';

    // ── Offline Fallback (8.4): re-route on infrastructure errors ──
    if (_fallbackAttempt === 0) {
      const fallbackModel = findOfflineFallback(modelId, errMsg);
      if (fallbackModel) {
        console.warn(
          `[OfflineFallback] ${subtask.id}: ${modelId} failed (${errMsg.substring(0, 80)}), ` +
          `re-routing → ${fallbackModel.modelId}`,
        );
        subtask.assignedModel = fallbackModel.modelId;
        const fallbackResult = await executeSubtask(subtask, taskId, context, mastra, 1);
        fallbackResult.actualModel = fallbackModel.modelId;
        return fallbackResult;
      }
    }

    return {
      subtaskId: subtask.id,
      status: 'failed',
      assignedModel: modelId,
      filesChanged: [],
      commandsRun: [],
      diagnostics: '',
      errors: [errMsg],
      durationMs: Date.now() - startTime,
    };
  }
}

// ── Offline Fallback Model Selection (8.4) ───────────────────────────────────

/**
 * Find a fallback model when the assigned model is unreachable.
 * Cloud error → prefer cheapest local model (free).
 * Local error → prefer cheapest cloud model.
 */
function findOfflineFallback(failedModelId: string, errorMessage: string): ModelCapability | null {
  const isLocal = failedModelId.startsWith('ollama/');
  const errLower = errorMessage.toLowerCase();

  // Heuristics to detect infrastructure errors (not logic errors)
  const isInfraError =
    errLower.includes('timeout') ||
    errLower.includes('econnrefused') ||
    errLower.includes('econnreset') ||
    errLower.includes('fetch failed') ||
    errLower.includes('network') ||
    errLower.includes('503') ||
    errLower.includes('502') ||
    errLower.includes('429') ||
    errLower.includes('rate limit') ||
    errLower.includes('oom') ||
    errLower.includes('out of memory') ||
    errLower.includes('gpu') ||
    errLower.includes('ollama');

  if (!isInfraError) return null; // Logic error — don't fallback, let retry handle it

  if (isLocal) {
    // Local model failed → find cheapest cloud
    return modelRegistry.find((m) => m.vramMb === 0 && m.available) ?? null;
  } else {
    // Cloud model failed → find cheapest local with GPU available
    try {
      const { getGpuGuard } = require('./gpu-guard.js');
      const guard = getGpuGuard();
      const snapshot = guard.getSnapshot();
      if (!snapshot.gpuAvailable) return null;

      return modelRegistry.find((m) =>
        m.vramMb > 0 &&
        m.available &&
        m.vramMb <= snapshot.availableForModelsMb,
      ) ?? null;
    } catch {
      return null; // No GPU info — can't fallback to local
    }
  }
}

// ── Quality Validation ───────────────────────────────────────────────────────

/**
 * Validate whether a subtask result actually solved the problem.
 * 5 quality signals are checked.
 */
export async function validateSubtaskQuality(
  subtask: RoutableSubtask,
  result: SubtaskResult,
): Promise<QualityValidation> {
  const signals: QualitySignal[] = [];

  // 1. No files changed (but task requires editing)
  if (result.filesChanged.length === 0 && subtask.type !== 'test') {
    signals.push('no_files_changed');
  }

  // 2. Target files missed — didn't touch required files
  if (subtask.targetFiles.length > 0) {
    const editedPaths = new Set(result.filesChanged.map((f) => f.path));
    const missedTargets = subtask.targetFiles.filter((t) => !editedPaths.has(t));
    if (missedTargets.length > 0) {
      signals.push('target_files_missed');
    }
  }

  // 3. TSC errors after changes
  const tscCmd = result.commandsRun.find((c) => c.command.includes('tsc'));
  if (tscCmd && tscCmd.exitCode !== 0) {
    signals.push('tsc_errors');
  }

  // 4. Agent self-reported failure
  const failureKeywords = ['nie udało', 'nie mogę', 'nie dał rady', 'error:', 'failed to', 'cannot'];
  if (failureKeywords.some((kw) => result.diagnostics.toLowerCase().includes(kw))) {
    signals.push('agent_reported_failure');
  }

  // 5. Empty diagnostics — agent didn't describe what it did
  if (!result.diagnostics || result.diagnostics.trim().length < 10) {
    signals.push('empty_diagnostics');
  }

  const passed = signals.length === 0;
  return {
    passed,
    reason: passed
      ? 'All quality checks passed'
      : `Quality issues: ${signals.join(', ')}`,
    signals,
  };
}

// ── Intelligent Retry & Escalation Loop ──────────────────────────────────────

/**
 * Process subtask results from a parallel group:
 * - Successful results pass through unchanged.
 * - Failed/partial results get retried with enriched prompt, then escalated.
 */
export async function retryFailedSubtasks(
  results: SubtaskResult[],
  group: RoutingResult['groups'][0],
  taskId: string,
  context: SubtaskContext,
  mastra: Mastra,
): Promise<SubtaskResult[]> {
  const finalResults: SubtaskResult[] = [];

  for (const result of results) {
    // Successes and skips pass through
    if (result.status === 'success' || result.status === 'skipped') {
      result.qualityCheck = { passed: true, reason: 'Status OK', attempt: 1, escalationHistory: [] };
      finalResults.push(result);
      continue;
    }

    const match = group.subtasks.find((s) => s.subtask.id === result.subtaskId);
    if (!match) {
      finalResults.push(result);
      continue;
    }
    const subtask = { ...match.subtask };

    // ── Quality check on initial result ──
    const quality = await validateSubtaskQuality(subtask, result);

    if (quality.passed) {
      result.qualityCheck = { passed: true, reason: quality.reason, attempt: 1, escalationHistory: [] };
      // Even if status was 'partial' or 'failed' from executor, quality says OK
      result.status = 'success';
      logAgentEvent({ type: 'task_completed', agentId: 'codingAgent', taskId, subtaskId: result.subtaskId, model: result.assignedModel, status: 'success' });
      finalResults.push(result);
      continue;
    }

    // ── ATTEMPT 2: Retry with same model, enriched prompt ──
    console.warn(`[SubtaskExecutor] Retry ${result.subtaskId}: ${quality.reason}`);

    const retryResult = await executeSubtask(
      subtask,
      taskId,
      { ...context, retryContext: result },
      mastra,
    );
    const retryQuality = await validateSubtaskQuality(subtask, retryResult);

    if (retryQuality.passed) {
      retryResult.qualityCheck = {
        passed: true,
        reason: 'Passed on retry',
        attempt: 2,
        escalationHistory: [{ model: result.assignedModel, reason: quality.reason }],
      };
      retryResult.status = 'success';

      // ── Phase 0 — Bug #2.1: Auto-save lesson after successful retry ──
      try {
        const db = await getDb();
        await db.collection('signals').insertOne({
          id: randomUUID(),
          type: 'lesson_learned',
          sourceAgent: 'subtask-executor',
          data: {
            task_pattern: `${subtask.type} on ${subtask.targetFiles.join(', ')}`,
            lesson: `Retry succeeded: ${retryQuality.reason}. Original failure: ${quality.reason}`,
            preset: retryResult.assignedModel,
          },
          expiresAt: new Date(Date.now() + 720 * 3600 * 1000), // 30 days
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn('[SubtaskExecutor] Failed to save lesson:', (err as Error).message);
      }

      logAgentEvent({ type: 'retry_success', agentId: 'codingAgent', taskId, subtaskId: result.subtaskId, model: retryResult.assignedModel, status: 'success', metadata: { attempt: 2 } });

      finalResults.push(retryResult);
      continue;
    }

    // ── ATTEMPT 3: Escalate to stronger model ──
    const escalationModel = getEscalationModel(
      retryResult.assignedModel,
      subtask,
      new Set([retryResult.assignedModel]),
    );

    if (escalationModel) {
      console.warn(
        `[SubtaskExecutor] Escalate ${result.subtaskId}: ${retryResult.assignedModel} → ${escalationModel.modelId}`,
      );

      subtask.assignedModel = escalationModel.modelId;
      const escalatedResult = await executeSubtask(subtask, taskId, context, mastra);
      const escalatedQuality = await validateSubtaskQuality(subtask, escalatedResult);

      escalatedResult.actualModel = escalationModel.modelId;
      escalatedResult.qualityCheck = {
        passed: escalatedQuality.passed,
        reason: escalatedQuality.passed ? 'Passed after escalation' : escalatedQuality.reason,
        attempt: 3,
        escalationHistory: [
          { model: result.assignedModel, reason: quality.reason },
          { model: retryResult.assignedModel, reason: retryQuality.reason },
        ],
      };

      escalatedResult.status = escalatedQuality.passed ? 'success' : 'needs_human';

      // ── Phase 0 — Bug #2.1: Auto-save lesson after successful escalation ──
      if (escalatedQuality.passed) {
        try {
          const db = await getDb();
          await db.collection('signals').insertOne({
            id: randomUUID(),
            type: 'lesson_learned',
            sourceAgent: 'subtask-executor',
            data: {
              task_pattern: `${subtask.type} on ${subtask.targetFiles.join(', ')}`,
              lesson: `Escalation from ${retryResult.assignedModel} to ${escalationModel.modelId} succeeded. Original failures: ${quality.reason}; ${retryQuality.reason}`,
              preset: escalationModel.modelId,
            },
            expiresAt: new Date(Date.now() + 720 * 3600 * 1000), // 30 days
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          console.warn('[SubtaskExecutor] Failed to save escalation lesson:', (err as Error).message);
        }
      }

      logAgentEvent({ type: escalatedQuality.passed ? 'task_completed' : 'task_failed', agentId: 'codingAgent', taskId, subtaskId: result.subtaskId, model: escalationModel.modelId, status: escalatedQuality.passed ? 'success' : 'error', metadata: { attempt: 3, escalation: true } });

      finalResults.push(escalatedResult);
    } else {
      // No escalation model available → mark needs_human
      retryResult.status = 'needs_human';
      retryResult.qualityCheck = {
        passed: false,
        reason: `No escalation path available: ${retryQuality.reason}`,
        attempt: 2,
        escalationHistory: [{ model: result.assignedModel, reason: quality.reason }],
      };
      logAgentEvent({ type: 'task_failed', agentId: 'codingAgent', taskId, subtaskId: result.subtaskId, model: retryResult.assignedModel, status: 'error', errorMessage: retryQuality.reason, metadata: { noEscalationPath: true } });
      finalResults.push(retryResult);
    }
  }

  return finalResults;
}

// ── Escalation Model Selection ───────────────────────────────────────────────

function getEscalationModel(
  currentModelId: string,
  subtask: RoutableSubtask,
  excludedModels: Set<string>,
): ModelCapability | null {
  const currentModel = modelRegistry.find((m) => m.modelId === currentModelId);
  if (!currentModel) return null;

  const path = ESCALATION_PATH[currentModel.tier] ?? [];

  for (const tierName of path) {
    const candidate = modelRegistry.find((m) =>
      m.tier === tierName &&
      m.available &&
      !excludedModels.has(m.modelId) &&
      complexityMeetsRequirement(m.maxComplexity, subtask.estimatedComplexity ?? 'simple'),
    );
    if (candidate) return candidate;
  }

  return null;
}

// ── Prompt Builders ──────────────────────────────────────────────────────────

function buildSubtaskPrompt(
  subtask: RoutableSubtask,
  taskId: string,
  context: SubtaskContext,
): string {
  return [
    `## Subtask: ${subtask.id}`,
    `Typ: ${subtask.type} | Complexity: ${subtask.estimatedComplexity ?? 'simple'}`,
    ``,
    `### Opis zadania`,
    (subtask as any).description ?? 'Brak opisu',
    ``,
    `### Pliki do edycji`,
    subtask.targetFiles.length > 0
      ? subtask.targetFiles.map((f) => `- ${f}`).join('\n')
      : '(brak wyspecyfikowanych — ustal sam)',
    ``,
    `### Kontekst z poprzednich subtasków`,
    context.previousResults.length > 0
      ? context.previousResults
          .map((r) => `[${r.subtaskId}] ${r.status}: ${r.diagnostics.substring(0, 200)}`)
          .join('\n')
      : '(pierwszy subtask — brak kontekstu)',
    ``,
    `### Instrukcje`,
    `- Pracuj TYLKO na plikach z listy powyżej (chyba że to 'create' task)`,
    `- Nie edytuj plików poza swoim scope`,
    `- Użyj coding.write_file_tracked z taskId="${taskId}"`,
    `- Po zakończeniu opisz co zrobiłeś w coding.update_artifact`,
    `- Twój subtaskId: ${subtask.id}`,
    `- Uruchom npx tsc --noEmit po zmianach, aby zweryfikować poprawność`,
  ].join('\n');
}

function buildRetryPrompt(
  subtask: RoutableSubtask,
  previousResult: SubtaskResult,
  taskId: string,
  context: SubtaskContext,
): string {
  return [
    `## RETRY subtask: ${subtask.id} (próba ${(previousResult.qualityCheck?.attempt ?? 1) + 1})`,
    ``,
    `### Co poszło nie tak w poprzedniej próbie:`,
    previousResult.qualityCheck?.reason ?? 'Nieznany powód',
    ``,
    `### Poprzednia diagnostyka agenta:`,
    previousResult.diagnostics || '(brak)',
    ``,
    `### Błędy z poprzedniej próby:`,
    previousResult.errors.length > 0
      ? previousResult.errors.join('\n')
      : '(brak jawnych błędów — ale wynik nie spełnia kryteriów)',
    ``,
    `### Pliki zmienione (mogą wymagać poprawki):`,
    previousResult.filesChanged.map((f) => `- ${f.path}: ${f.summary}`).join('\n') || '(żadne)',
    ``,
    `### Oryginalne zadanie:`,
    (subtask as any).description ?? 'Brak opisu',
    ``,
    `### Pliki docelowe:`,
    subtask.targetFiles.map((f) => `- ${f}`).join('\n'),
    ``,
    `### Instrukcje retry:`,
    `- Przeanalizuj DLACZEGO poprzednia próba nie zadziałała`,
    `- Przeczytaj pliki docelowe ponownie — mogły się zmienić`,
    `- Napraw konkretne problemy wymienione powyżej`,
    `- Użyj coding.write_file_tracked z taskId="${taskId}"`,
    `- Uruchom npx tsc --noEmit po zmianach`,
    `- Twój subtaskId: ${subtask.id}`,
  ].join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTimeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Extract diagnostics summary from agent response.
 */
function extractDiagnostics(response: any): string {
  try {
    if (typeof response === 'string') return response.substring(0, 1000);
    if (response?.text) return response.text.substring(0, 1000);
    if (response?.output) return response.output.substring(0, 1000);
    return JSON.stringify(response).substring(0, 500);
  } catch {
    return '';
  }
}

/**
 * Collect subtask results from the artifact in MongoDB.
 * After the agent runs, it should have updated the artifact via tools.
 */
async function collectSubtaskResult(
  taskId: string,
  subtaskId: string,
): Promise<{
  filesChanged: Array<{ path: string; summary: string }>;
  commandsRun: Array<{ command: string; exitCode: number; summary: string }>;
  errors: string[];
  hasErrors: boolean;
}> {
  try {
    const db = await getDb();
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

    if (!artifact) {
      return { filesChanged: [], commandsRun: [], errors: ['Artifact not found'], hasErrors: true };
    }

    const filesChanged = (artifact.filesChanged ?? []).map((f: any) => ({
      path: f.path,
      summary: f.summary ?? '',
    }));

    const commandsRun = (artifact.commandsRun ?? []).map((c: any) => ({
      command: c.command,
      exitCode: c.exitCode ?? 0,
      summary: c.summary ?? '',
    }));

    const tscErrors = commandsRun.filter((c: any) =>
      c.command.includes('tsc') && c.exitCode !== 0,
    );

    return {
      filesChanged,
      commandsRun,
      errors: tscErrors.map((e: any) => `TSC error: ${e.summary}`),
      hasErrors: tscErrors.length > 0,
    };
  } catch (err) {
    return {
      filesChanged: [],
      commandsRun: [],
      errors: [(err as Error).message],
      hasErrors: true,
    };
  }
}
