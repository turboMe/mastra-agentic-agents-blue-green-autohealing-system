/**
 * run_deliberation_worker — spawn a role-specific LLM executor for Design Council debates.
 *
 * This tool replaces the generic runWorkerTool for deliberationAgent,
 * mapping strict roles to specific models defined in model-manifest.ts.
 *
 * It prevents hallucinations where the agent guesses preset names and
 * ensures strict architectural control over which model plays which role.
 */
import { createTool } from '@mastra/core/tools';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { deliberationAssignments, resolveModelId } from '../../config/model-manifest.js';

const ROLE_TO_MODEL: Record<string, string> = Object.fromEntries(
  Object.entries(deliberationAssignments).map(([k, v]) => [k, resolveModelId(v)]),
);

export const runDeliberationWorkerTool = createTool({
  id: 'run_deliberation_worker',
  description: `Spawns an LLM worker bound to a specific Design Council role.
The model for each role is pre-configured by the system architecture.
Use this instead of delegating to full expert agents.
CAN be called multiple times in parallel for independent sub-tasks or multiple roles.`,

  inputSchema: z.object({
    role: z.enum([
      'systemsArchitect',
      'llmEngineer',
      'redTeamCritic',
      'creativeStrategist',
      'memoryArchitect',
      'synthesisPlanner',
    ]).describe('The specific Design Council role to execute.'),

    taskBrief: z
      .string()
      .min(50)
      .describe(
        'Full worker brief IN ENGLISH. Must contain: GOAL, CONTEXT, INPUT, OUTPUT FORMAT, CONSTRAINTS. ' +
          'Be ruthlessly explicit — small models have no background knowledge.',
      ),

    attemptNumber: z.number().int().min(1).max(3).default(1).describe('Attempt counter (1–3). Pass 2 or 3 on retries.'),

    previousAttempt: z
      .object({
        output: z.string().describe('The bad output from the previous attempt'),
        criticism: z.string().describe('Why it was wrong / what to fix'),
      })
      .optional()
      .describe('On retry: pass the previous bad output and your diagnosis. The worker will see what NOT to do.'),
  }),

  outputSchema: z.object({
    output: z.string(),
    model: z.string(),
    role: z.string(),
    attemptNumber: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async (input, { mastra }) => {
    // If somehow the role is wrong, fallback to synthesisPlanner model.
    const modelId = ROLE_TO_MODEL[input.role] ?? ROLE_TO_MODEL.synthesisPlanner;
    const attemptNumber = input.attemptNumber ?? 1;

    let systemPrompt = input.taskBrief;

    // Optional retry context injection
    if (input.previousAttempt && attemptNumber > 1) {
      systemPrompt += `\n\n---
[RETRY CONTEXT - ATTEMPT ${attemptNumber}]
You previously generated an output that was rejected.

PREVIOUS BAD OUTPUT:
"""
${input.previousAttempt.output}
"""

CRITICISM / REASON FOR REJECTION:
"""
${input.previousAttempt.criticism}
"""

Please fix the mistakes and try again.`;
    }

    try {
      const adHocWorker = new Agent({
        id: `deliberation-worker-${input.role}-${Date.now()}`,
        name: `Ad-Hoc Deliberation Worker (${input.role})`,
        instructions:
          `You are an AI executing the role of ${input.role} in a Design Council debate.\n` +
          'You are a pure text-in-text-out function. No tools, no memory.\n' +
          'Follow the task brief EXACTLY. Do not invent facts. Return ONLY the requested format.',
        model: modelId as any,
      });

      // Execute worker
      const res = await adHocWorker.generate(systemPrompt);

      return {
        output: res.text ?? '',
        model: modelId,
        role: input.role,
        attemptNumber: attemptNumber,
        success: true,
      };
    } catch (err: any) {
      console.error(`[runDeliberationWorkerTool] Error running ${input.role} on ${modelId}:`, err);
      return {
        output: '',
        model: modelId,
        role: input.role,
        attemptNumber: attemptNumber,
        success: false,
        error: err?.message || String(err),
      };
    }
  },
});
