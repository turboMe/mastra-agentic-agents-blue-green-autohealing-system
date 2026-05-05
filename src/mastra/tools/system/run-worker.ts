/**
 * system.run_worker — spawn a blank LLM executor with a custom brief.
 *
 * Unlike delegate_task (expert agents with personality + tools),
 * run_worker creates an ad-hoc model with NO extra prompt and NO tools.
 * Meta-agent writes the full brief including role, context, format.
 *
 * Preset → Ollama model mapping (local-first, cloud fallback):
 *   fast      → gemma4:e4b        (8B,  quick classification / JSON extraction)
 *   default   → gemma4:26b        (26B, Polish copy, summaries, generic generation)
 *   reasoning → qwen3-coder:30b   (30B, analysis, math, code, structured planning)
 *   powerful  → qwen3.5-abliterated:35b (35B, long-form, creative, uncensored)
 *   cloud     → gemini-2.5-flash  (remote fallback when local can't handle)
 */
import { createTool } from '@mastra/core/tools';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

const PRESET_TO_MODEL: Record<string, string> = {
  fast:      'ollama/local/gemma4:e4b',
  default:   'ollama/local/gemma4:26b',
  reasoning: 'ollama/local/qwen3-coder:30b',
  powerful:  'ollama/huihui_ai/qwen3.5-abliterated:35b',
  cloud:     'google/gemini-2.5-flash',
};

export const runWorkerTool = createTool({
  id: 'system.run_worker',
  description: `Spawns a blank LLM worker with a custom brief written by meta-agent.
No built-in personality, no tools — pure text-in-text-out generation.
Use for ad-hoc tasks that do not fit any registered expert (delegate_task).
CAN be called multiple times in parallel for independent sub-tasks.

Presets:
- fast      → gemma4:e4b     (classification, JSON extraction, reformatting)
- default   → gemma4:26b     (Polish copy, summaries, general generation)
- reasoning → qwen3-coder:30b (analysis, math, code, structured plans)
- powerful  → qwen3.5-abliterated:35b (long-form, creative, difficult reasoning)
- cloud     → gemini-2.5-flash (cloud fallback when local models insufficient)`,

  inputSchema: z.object({
    preset: z
      .enum(['fast', 'default', 'reasoning', 'powerful', 'cloud'])
      .describe('Model size preset. Choose based on task complexity.'),

    taskBrief: z
      .string()
      .min(50)
      .describe(
        'Full worker brief IN ENGLISH. Must contain: GOAL, CONTEXT, INPUT, OUTPUT FORMAT, CONSTRAINTS. ' +
        'Be ruthlessly explicit — small models have no background knowledge.',
      ),

    attemptNumber: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe('Attempt counter (1–3). Pass 2 or 3 on retries.'),

    previousAttempt: z
      .object({
        output: z.string().describe('The bad output from the previous attempt'),
        criticism: z.string().describe('Why it was wrong / what to fix'),
      })
      .optional()
      .describe(
        'On retry: pass the previous bad output and your diagnosis. ' +
        'The worker will see what NOT to do.',
      ),
  }),

  outputSchema: z.object({
    output: z.string(),
    model: z.string(),
    attemptNumber: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async (ctx) => {
    const modelId = PRESET_TO_MODEL[ctx.preset] ?? PRESET_TO_MODEL.default;

    // Build the full system prompt: brief + optional retry context
    let systemPrompt = ctx.taskBrief;

    if (ctx.previousAttempt) {
      systemPrompt +=
        '\n\n---\n' +
        '## ⚠️ Previous attempt (DO NOT REPEAT THIS)\n\n' +
        ctx.previousAttempt.output +
        '\n\n## Why it was wrong\n\n' +
        ctx.previousAttempt.criticism +
        '\n\n## Your task now\n\n' +
        'Produce a corrected output that directly addresses the criticism above. ' +
        'Do not explain what you changed — just deliver the correct result.';
    }

    try {
      // Create ad-hoc agent: no tools, no extra personality — brief IS the system prompt
      const worker = new Agent({
        id: `run-worker-${ctx.preset}-${Date.now()}`,
        name: `Worker [${ctx.preset} / attempt ${ctx.attemptNumber}]`,
        // Minimal base instruction — the taskBrief carries all the specifics
        instructions: 'You are a focused executor. Follow the task brief exactly. Return only what is requested — nothing more.',
        model: modelId,
      });

      const result = await worker.generate(systemPrompt);

      return {
        output: result.text,
        model: modelId,
        attemptNumber: ctx.attemptNumber ?? 1,
        success: true,
      };
    } catch (error) {
      // If local Ollama model failed, surface a clean error so meta can retry with 'cloud'
      return {
        output: '',
        model: modelId,
        attemptNumber: ctx.attemptNumber ?? 1,
        success: false,
        error: (error as Error).message,
      };
    }
  },
});
