/**
 * Stable generateAutomation() gateway for Automation Architect calls.
 */

import { buildAutomationPrecontext } from './automation-precontext.js';
import { AUTOMATION_ARCHITECT_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { generateWithHarness } from './generate-with-harness.js';
import type {
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
} from './generate-with-harness.js';

export type AutomationHarnessPhase = Extract<
  HarnessPhase,
  'discover' | 'compose' | 'validate' | 'deploy' | 'test' | 'repair' | 'activate' | 'chat'
>;

export type AutomationGenerateInput = Omit<HarnessGenerateInput, 'agentId' | 'phase'> & {
  agentId?: string;
  phase: AutomationHarnessPhase;
};

export async function generateAutomation<TResponse = unknown>(
  input: AutomationGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  return generateWithHarness<TResponse>({
    ...input,
    agentId: canonicalizeRuntimeAgentId(input.agentId) ?? AUTOMATION_ARCHITECT_AGENT_ID,
    precontextFeatureFlag: 'FEATURE_AUTOMATION_PRECONTEXT',
    precontextFeature: 'automation_precontext',
    precontextDefaultEnabled: true,
    memoryResource: input.memoryResource ?? AUTOMATION_ARCHITECT_AGENT_ID,
    contextBuilder: (context) => buildAutomationPrecontext({
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: context.agentId,
      threadId: context.threadId,
      userPrompt: context.userPrompt,
      maxTokens: context.maxTokens ?? 1800,
      automationId: context.automationId,
      workflowId: context.workflowId,
      patternId: context.patternId,
    }),
  });
}
