/**
 * Stable generateCoding() gateway for coding LLM calls.
 *
 * The shared harness core lives in generate-with-harness.ts; this file keeps
 * the public coding-agent contract unchanged.
 */

import { buildCodingPrecontext } from './coding-precontext.js';
import { CODING_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { generateWithHarness } from './generate-with-harness.js';
import type {
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
} from './generate-with-harness.js';

export type {
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
};

export async function generateCoding<TResponse = unknown>(
  input: HarnessGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  return generateWithHarness<TResponse>({
    ...input,
    precontextFeatureFlag: 'FEATURE_CODING_PRECONTEXT',
    precontextFeature: 'coding_precontext',
    precontextDefaultEnabled: false,
    memoryResource: input.memoryResource ?? canonicalizeRuntimeAgentId(input.agentId) ?? CODING_AGENT_ID,
    contextBuilder: (context) => buildCodingPrecontext({
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: context.agentId,
      threadId: context.threadId,
      userPrompt: context.userPrompt,
      repoPath: context.repoPath,
      targetFiles: context.targetFiles,
      maxTokens: context.maxTokens ?? 2048,
      includeMemory: context.includeMemory,
      includeSkills: context.includeSkills,
      includeRepoMap: context.includeRepoMap,
      includeCheckpoint: context.includeCheckpoint,
    }),
  });
}
