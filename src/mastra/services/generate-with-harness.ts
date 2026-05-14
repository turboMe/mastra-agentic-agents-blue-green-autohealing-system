/**
 * Generic Mastra harness generate gateway.
 *
 * Keeps the operational wrapper shared across agents while allowing each agent
 * to provide its own dynamic pre-context builder.
 */

import { createHash, randomUUID } from 'crypto';

import type { Agent } from '@mastra/core/agent';
import { isHarnessFeatureEnabled, type HarnessFeatureFlagName } from '../config/harness-flags.js';
import { logHarnessEvent, tokenEstimate } from './harness-events.js';
import { scheduleSemanticMemoryCheck } from './semantic-memory-worker.js';
import { beginHarnessTurn, completeHarnessTurn, failHarnessTurn } from './harness-run-state.js';
import { isWorkspaceTool, logPostHocToolExecution } from './harness-tool-envelope.js';
import { runWithHarnessExecutionContext } from './harness-execution-context.js';

export type HarnessPhase =
  // Coding phases
  | 'diagnose'
  | 'plan'
  | 'subtask'
  | 'retry'
  | 'review'
  | 'merge'
  | 'cleanup'
  // Automation phases
  | 'discover'
  | 'compose'
  | 'validate'
  | 'deploy'
  | 'test'
  | 'repair'
  | 'activate'
  // Knowledge/NotebookLM phases
  | 'list'
  | 'source'
  | 'query'
  | 'research'
  | 'studio'
  // Shared
  | 'chat';

export type HarnessContextBuilderInput = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  userPrompt: string;
  repoPath?: string;
  targetFiles?: string[];
  maxTokens?: number;
  includeMemory?: boolean;
  includeSkills?: boolean;
  includeRepoMap?: boolean;
  includeCheckpoint?: boolean;
  automationId?: string;
  workflowId?: string;
  patternId?: string;
};

export type HarnessPrecontextResult = {
  markdown: string;
  tokenEstimate?: number;
  [key: string]: unknown;
};

export type HarnessGenerateInput = {
  agent: Agent;
  agentId: string;
  prompt: string;
  taskId?: string;
  subtaskId?: string;
  threadId?: string;
  runId?: string;
  repoPath?: string;
  targetFiles?: string[];
  model?: string;
  phase: HarnessPhase;
  timeoutMs?: number;
  cachePolicy?: 'static-only' | 'disabled';
  memoryResource?: string;
  precontextFeatureFlag?: HarnessFeatureFlagName;
  precontextFeature?: string;
  precontextDefaultEnabled?: boolean;
  contextBuilder?: (input: HarnessContextBuilderInput) => Promise<HarnessPrecontextResult | null>;
  automationId?: string;
  workflowId?: string;
  patternId?: string;
  contextPolicy?: {
    includeMemory?: boolean;
    includeSkills?: boolean;
    includeRepoMap?: boolean;
    includeCheckpoint?: boolean;
    maxTokens?: number;
  };
  generateOptions?: Record<string, unknown>;
};

export type HarnessGenerateResult<TResponse = unknown> = {
  runId: string;
  turnId: string;
  response: TResponse;
  promptHash: string;
  contextHash?: string;
  outputPreview: string;
  outputArtifactId?: string;
  durationMs: number;
  model?: string;
  eventsWritten: number;
};

export async function generateWithHarness<TResponse = unknown>(
  input: HarnessGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  const runId = input.runId ?? input.taskId ?? randomUUID();
  const turnId = randomUUID();
  const threadId = input.threadId ?? input.taskId;
  const harnessEnabled = isHarnessFeatureEnabled('FEATURE_MASTRA_HARNESS', true);
  const precontextEnabled = input.precontextFeatureFlag
    ? isHarnessFeatureEnabled(input.precontextFeatureFlag, input.precontextDefaultEnabled ?? false)
    : false;
  const start = Date.now();
  let eventsWritten = 0;
  const precontext = precontextEnabled && input.contextBuilder
    ? await input.contextBuilder({
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        agentId: input.agentId,
        threadId: input.threadId,
        userPrompt: input.prompt,
        repoPath: input.repoPath,
        targetFiles: input.targetFiles,
        maxTokens: input.contextPolicy?.maxTokens,
        includeMemory: input.contextPolicy?.includeMemory,
        includeSkills: input.contextPolicy?.includeSkills,
        includeRepoMap: input.contextPolicy?.includeRepoMap,
        includeCheckpoint: input.contextPolicy?.includeCheckpoint,
        automationId: input.automationId,
        workflowId: input.workflowId,
        patternId: input.patternId,
      })
    : null;
  const finalPrompt = precontext?.markdown
    ? `${precontext.markdown}\n\n---\n\n${input.prompt}`
    : input.prompt;
  const contextHash = precontext?.markdown ? hashText(precontext.markdown) : undefined;
  const originalPromptHash = hashText(input.prompt);
  const promptHash = hashText(finalPrompt);
  const promptTokensEstimate = tokenEstimate(finalPrompt);

  if (harnessEnabled) {
    await beginHarnessTurn({
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      agentId: input.agentId,
      phase: input.phase,
      repoPath: input.repoPath,
      model: input.model,
      promptHash,
      contextHash,
    });
  }

  if (harnessEnabled && precontextEnabled && precontext) {
    await logHarnessEvent({
      type: 'precontext_injected',
      agentId: input.agentId,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: input.precontextFeature ?? 'agent_precontext',
      model: input.model,
      status: 'success',
      output: precontext.markdown,
      data: {
        injected: precontext.markdown.length > 0,
        tokenEstimate: precontext.tokenEstimate ?? tokenEstimate(precontext.markdown),
        contextHash,
        ...precontextTelemetry(precontext),
      },
    });
    eventsWritten += 1;
  }

  if (harnessEnabled) {
    await logHarnessEvent({
      type: 'llm_call_started',
      agentId: input.agentId,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'mastra_harness',
      model: input.model,
      status: 'pending',
      data: {
        phase: input.phase,
        repoPath: input.repoPath,
        targetFiles: input.targetFiles,
        promptHash,
        originalPromptHash,
        contextHash,
        promptTokensEstimate,
        cachePolicy: input.cachePolicy ?? 'static-only',
        contextPolicy: input.contextPolicy,
        precontextApplied: !!precontext?.markdown,
        precontextFeature: input.precontextFeature,
      },
    });
    eventsWritten += 1;
  }

  try {
    const response = await callAgentGenerate<TResponse>({ ...input, prompt: finalPrompt }, { runId, turnId, threadId });
    const durationMs = Date.now() - start;

    const resp = response as Record<string, unknown>;
    const steps = Array.isArray(resp.steps) ? resp.steps as Array<Record<string, unknown>> : [];
    const allToolCalls = steps.flatMap((s) => Array.isArray(s.toolCalls) ? s.toolCalls as Array<Record<string, unknown>> : []);
    const allToolResults = steps.flatMap((s) => Array.isArray(s.toolResults) ? s.toolResults as Array<Record<string, unknown>> : []);
    console.log(`[Harness] Response: text=${(resp.text as string || '').length} chars, finishReason=${resp.finishReason}, steps=${steps.length}, toolCalls=${allToolCalls.length}, toolResults=${allToolResults.length}`);
    if (allToolCalls.length > 0) {
      allToolCalls.forEach((tc) => {
        const payload = tc.payload as Record<string, unknown> | undefined;
        const name = payload?.toolName || tc.toolName || 'unknown';
        const args = payload?.args || tc.args || {};
        console.log(`[Harness]   toolCall: ${name} args=${JSON.stringify(args).slice(0, 300)}`);
      });
    }
    if (allToolResults.length > 0) {
      allToolResults.forEach((tr) => {
        console.log(`[Harness]   toolResult: ${tr.toolName} result=${JSON.stringify(tr.result || '').slice(0, 200)}`);
      });
    }
    if (resp.finishReason === 'suspended') {
      console.warn('[Harness] Agent suspended by approval-gated tool. suspendPayload:', JSON.stringify((resp as any).suspendPayload || {}).slice(0, 300));
    }
    console.log(`[Harness] Response keys: ${Object.keys(resp).join(', ')}`);
    console.log(`[Harness] Full response (truncated): ${JSON.stringify(resp).slice(0, 800)}`);

    const outputPreview = extractOutputPreview(response);

    if (harnessEnabled) {
      await logHarnessEvent({
        type: 'llm_call_completed',
        agentId: input.agentId,
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        feature: 'mastra_harness',
        model: input.model,
        status: 'success',
        durationMs,
        output: outputPreview,
        data: {
          phase: input.phase,
          promptHash,
          originalPromptHash,
          contextHash,
          outputTokensEstimate: tokenEstimate(outputPreview),
          precontextApplied: !!precontext?.markdown,
          precontextFeature: input.precontextFeature,
        },
      });
      eventsWritten += 1;
    }

    if (harnessEnabled) {
      await completeHarnessTurn({
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        agentId: input.agentId,
        phase: input.phase,
        repoPath: input.repoPath,
        model: input.model,
        promptHash,
        contextHash,
        durationMs,
        outputPreview,
      });
    }

    schedulePostTurnMemory(input, runId, turnId, outputPreview, undefined);

    return {
      runId,
      turnId,
      response,
      promptHash,
      contextHash,
      outputPreview,
      durationMs,
      model: input.model,
      eventsWritten,
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    const err = error as Error;

    if (harnessEnabled) {
      await logHarnessEvent({
        type: 'llm_call_failed',
        agentId: input.agentId,
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        feature: 'mastra_harness',
        model: input.model,
        status: 'error',
        durationMs,
        errorMessage: err.message,
        data: {
          phase: input.phase,
          promptHash,
          originalPromptHash,
          contextHash,
          errorClass: err.name || 'Error',
          precontextApplied: !!precontext?.markdown,
          precontextFeature: input.precontextFeature,
        },
      });
      eventsWritten += 1;
    }

    if (harnessEnabled) {
      await failHarnessTurn({
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        agentId: input.agentId,
        phase: input.phase,
        repoPath: input.repoPath,
        model: input.model,
        promptHash,
        contextHash,
        durationMs,
        errorClass: err.name || 'Error',
        errorMessage: err.message,
      });
    }

    schedulePostTurnMemory(input, runId, turnId, undefined, err.message);
    throw error;
  }
}

async function callAgentGenerate<TResponse>(
  input: HarnessGenerateInput,
  harnessContext?: { runId: string; turnId: string; threadId?: string },
): Promise<TResponse> {
  const generateOptions: Record<string, unknown> = {
    maxSteps: 40,
    ...(input.generateOptions ?? {}),
  };

  if (input.model) {
    generateOptions.model = input.model;
  }

  if (input.threadId) {
    generateOptions.memory = {
      thread: input.threadId,
      resource: input.memoryResource ?? input.agentId ?? 'harness',
    };
  }

  if (harnessContext && isHarnessFeatureEnabled('FEATURE_TOOL_ENVELOPE', true)) {
    const ctx = harnessContext;
    generateOptions.onStepFinish = async (stepResult: Record<string, unknown>) => {
      const toolCalls = Array.isArray(stepResult.toolCalls) ? stepResult.toolCalls as Array<Record<string, unknown>> : [];
      const toolResults = Array.isArray(stepResult.toolResults) ? stepResult.toolResults as Array<Record<string, unknown>> : [];

      for (const tc of toolCalls) {
        const toolName = String(tc.toolName ?? tc.name ?? '');
        if (!toolName || !isWorkspaceTool(toolName)) continue;

        const matchingResult = toolResults.find((tr) => tr.toolCallId === tc.toolCallId);
        await logPostHocToolExecution({
          toolCallId: String(tc.toolCallId ?? ''),
          toolId: toolName,
          args: tc.args,
          result: matchingResult?.result,
          isError: matchingResult?.isError === true,
          agentId: input.agentId,
          runId: ctx.runId,
          turnId: ctx.turnId,
          threadId: ctx.threadId,
          taskId: input.taskId,
          subtaskId: input.subtaskId,
        });
      }
    };
  }

  console.log(`[Harness] callAgentGenerate: maxSteps=${generateOptions.maxSteps}, model=${generateOptions.model ?? 'agent-default'}, memory=${!!generateOptions.memory}, keys=${Object.keys(generateOptions).join(',')}`);

  return runWithHarnessExecutionContext(
    {
      agentId: input.agentId,
      runId: harnessContext?.runId,
      turnId: harnessContext?.turnId,
      threadId: harnessContext?.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
    },
    () => {
      const call = input.agent.generate(input.prompt, generateOptions as any); // @harness-exempt - this file is the harness gateway
      return withTimeout(
        call as Promise<TResponse>,
        input.timeoutMs,
        `Harness LLM call timed out after ${(input.timeoutMs ?? 0) / 1000}s`,
      );
    },
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
  message?: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message ?? 'Harness LLM call timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function extractOutputPreview(response: unknown): string {
  try {
    if (typeof response === 'string') return truncate(response, 1000);
    if (response && typeof response === 'object') {
      const record = response as Record<string, unknown>;

      if (typeof record.text === 'string' && record.text.length > 0) {
        return truncate(record.text, 1000);
      }

      if (Array.isArray(record.steps) && record.steps.length > 0) {
        const lastStep = record.steps[record.steps.length - 1] as Record<string, unknown>;
        if (typeof lastStep?.text === 'string' && lastStep.text.length > 0) {
          return truncate(lastStep.text, 1000);
        }
      }

      if (Array.isArray(record.toolResults) && record.toolResults.length > 0) {
        const summary = (record.toolResults as Array<Record<string, unknown>>)
          .map((tr) => `[${tr.toolName}] ${JSON.stringify(tr.result ?? '').slice(0, 200)}`)
          .join('\n');
        return truncate(summary, 1000);
      }

      if (typeof record.output === 'string') return truncate(record.output, 1000);
    }
    return truncate(JSON.stringify(response), 1000);
  } catch {
    return '';
  }
}

function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function schedulePostTurnMemory(
  input: HarnessGenerateInput,
  runId: string,
  turnId: string,
  outputPreview?: string,
  errorMessage?: string,
): void {
  const contextText = [
    `phase: ${input.phase}`,
    input.prompt,
    input.targetFiles?.length ? `target files: ${input.targetFiles.join(', ')}` : '',
    input.automationId ? `automationId: ${input.automationId}` : '',
    input.workflowId ? `workflowId: ${input.workflowId}` : '',
    input.patternId ? `patternId: ${input.patternId}` : '',
    outputPreview ? `output: ${outputPreview}` : '',
    errorMessage ? `error: ${errorMessage}` : '',
  ].filter(Boolean).join('\n\n');

  void scheduleSemanticMemoryCheck({
    threadId: input.threadId ?? input.taskId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    agentId: input.agentId,
    runId,
    turnId,
    model: input.model,
    contextText,
  });
}

function precontextTelemetry(precontext: HarnessPrecontextResult): Record<string, unknown> {
  const { markdown: _markdown, ...rest } = precontext;
  return rest;
}
