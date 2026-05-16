/**
 * Stable generateReview() gateway for Code Review Agent calls.
 */

import { CODE_REVIEW_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { buildReviewPrecontext } from './review-precontext.js';
import { generateWithHarness } from './generate-with-harness.js';
import type {
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
} from './generate-with-harness.js';

export type ReviewHarnessPhase = Extract<HarnessPhase, 'review'>;

export type ReviewGenerateInput = Omit<HarnessGenerateInput, 'agentId' | 'phase'> & {
  agentId?: string;
  phase?: ReviewHarnessPhase;
  reviewIteration?: number;
};

export async function generateReview<TResponse = unknown>(
  input: ReviewGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  const { agentId, phase: _phase, reviewIteration, ...rest } = input;
  const runtimeAgentId = canonicalizeRuntimeAgentId(agentId) ?? CODE_REVIEW_AGENT_ID;

  return generateWithHarness<TResponse>({
    ...rest,
    agentId: runtimeAgentId,
    phase: 'review',
    precontextFeatureFlag: 'FEATURE_REVIEW_PRECONTEXT',
    precontextFeature: 'review_precontext',
    precontextDefaultEnabled: true,
    memoryResource: rest.memoryResource ?? CODE_REVIEW_AGENT_ID,
    contextBuilder: (context) => buildReviewPrecontext({
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: runtimeAgentId,
      threadId: context.threadId,
      userPrompt: context.userPrompt,
      maxTokens: context.maxTokens ?? 1800,
      reviewIteration,
    }),
  });
}
