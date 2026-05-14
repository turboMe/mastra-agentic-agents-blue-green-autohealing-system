/**
 * Stable generateKnowledge() gateway for NotebookLM Knowledge Agent calls.
 */

import { buildKnowledgePrecontext } from './knowledge-precontext.js';
import { generateWithHarness } from './generate-with-harness.js';
import type {
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
} from './generate-with-harness.js';

export type KnowledgeHarnessPhase = Extract<
  HarnessPhase,
  'chat' | 'list' | 'source' | 'query' | 'research' | 'studio'
>;

export type KnowledgeGenerateInput = Omit<HarnessGenerateInput, 'agentId' | 'phase'> & {
  agentId?: string;
  phase: KnowledgeHarnessPhase;
};

export async function generateKnowledge<TResponse = unknown>(
  input: KnowledgeGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  return generateWithHarness<TResponse>({
    ...input,
    agentId: input.agentId ?? 'knowledgeAgent',
    precontextFeatureFlag: 'FEATURE_KNOWLEDGE_PRECONTEXT',
    precontextFeature: 'knowledge_precontext',
    precontextDefaultEnabled: true,
    memoryResource: input.memoryResource ?? 'knowledgeAgent',
    contextBuilder: (context) => buildKnowledgePrecontext({
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: context.agentId,
      threadId: context.threadId,
      userPrompt: context.userPrompt,
      maxTokens: context.maxTokens ?? 1400,
    }),
  });
}
