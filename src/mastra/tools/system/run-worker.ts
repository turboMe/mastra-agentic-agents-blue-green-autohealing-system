/**
 * system.run_worker — spawn a blank LLM executor with a custom brief.
 *
 * Unlike delegate_task (expert agents with personality + tools),
 * run_worker creates an ad-hoc model with NO extra prompt and NO tools.
 * Meta-agent writes the full brief including role, context, format.
 *
 * Phase 3.3: Now supports `skills` param — loads skill procedures from
 * the SkillRegistry and injects them into the worker's prompt.
 * Also supports `allowedTools` — a whitelist description for the worker
 * (informational only — workers are still text-in/text-out).
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
import { getSkillRegistry } from '../../services/skill-registry.js';
import { workerPresets, resolveModelId } from '../../config/model-manifest.js';

const PRESET_TO_MODEL: Record<string, string> = Object.fromEntries(
  Object.entries(workerPresets).map(([k, v]) => [k, resolveModelId(v)]),
);

export const runWorkerTool = createTool({
  id: 'system.run_worker',
  description: `Spawns a blank LLM worker with a custom brief written by meta-agent.
No built-in personality, no tools — pure text-in-text-out generation.
Use for ad-hoc tasks that do not fit any registered expert (delegate_task).
CAN be called multiple times in parallel for independent sub-tasks.

Phase 3.3: Supports 'skills' param — loads skill procedures and injects them into the worker prompt.

Presets:
- fast      → gemma4:e4b     (classification, JSON extraction, reformatting)
- default   → gemma4:26b     (Polish copy, summaries, general generation)
- reasoning → qwen3-coder:30b (analysis, math, code, structured plans)
- powerful  → qwen3.5-abliterated:35b (long-form, creative, difficult reasoning)
- cloud     → gemini-2.5-flash (cloud fallback when local models insufficient)`,

  inputSchema: z.object({
    preset: z.enum(['fast', 'default', 'reasoning', 'powerful', 'cloud']).describe('Model size preset. Choose based on task complexity.'),

    taskBrief: z
      .string()
      .min(50)
      .describe(
        'Full worker brief IN ENGLISH. Must contain: GOAL, CONTEXT, INPUT, OUTPUT FORMAT, CONSTRAINTS. ' +
          'Be ruthlessly explicit — small models have no background knowledge.',
      ),

    skills: z
      .array(z.string())
      .optional()
      .describe('List of skill names to load from the Skill Registry. Their procedures will be injected into the worker prompt.'),

    allowedTools: z
      .array(z.string())
      .optional()
      .describe('Informational whitelist of tools the worker should reference in its output (workers are text-only — this is for prompt context).'),

    attemptNumber: z.number().int().min(1).max(3).default(1).describe('Attempt counter (1–3). Pass 2 or 3 on retries.'),

    previousAttempt: z
      .object({
        output: z.string().describe('The bad output from the previous attempt'),
        criticism: z.string().describe('Why it was wrong / what to fix'),
      })
      .optional()
      .describe('On retry: pass the previous bad output and your diagnosis. ' + 'The worker will see what NOT to do.'),
  }),

  outputSchema: z.object({
    output: z.string(),
    model: z.string(),
    attemptNumber: z.number(),
    success: z.boolean(),
    skillsLoaded: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),

  execute: async (input, { mastra }) => {
    const modelId = PRESET_TO_MODEL[input.preset] ?? PRESET_TO_MODEL.default;

    // Build the full system prompt: brief + optional skill procedures + retry context
    let systemPrompt = input.taskBrief;
    const loadedSkillNames: string[] = [];

    // ── Phase 3.3: Load skill procedures ──
    if (input.skills && input.skills.length > 0) {
      try {
        const registry = getSkillRegistry();
        const skillSections: string[] = [];

        for (const skillName of input.skills) {
          const skill = await registry.load(skillName);
          if (skill) {
            skillSections.push(
              `\n---\n## Skill: ${skill.metadata.name}`,
              `> ${skill.metadata.description}`,
              '',
              skill.procedure,
            );
            loadedSkillNames.push(skillName);
          } else {
            console.warn(`[RunWorker] Skill not found: ${skillName}`);
          }
        }

        if (skillSections.length > 0) {
          systemPrompt += '\n\n' + skillSections.join('\n');
        }
      } catch (err) {
        console.warn('[RunWorker] Skill loading failed:', (err as Error).message);
      }
    }

    // ── Allowed tools context (informational) ──
    if (input.allowedTools && input.allowedTools.length > 0) {
      systemPrompt +=
        '\n\n## Available tools (reference only)\n' +
        input.allowedTools.map((t) => `- ${t}`).join('\n');
    }

    if (input.previousAttempt) {
      systemPrompt +=
        '\n\n---\n' +
        '## ⚠️ Previous attempt (DO NOT REPEAT THIS)\n\n' +
        input.previousAttempt.output +
        '\n\n## Why it was wrong\n\n' +
        input.previousAttempt.criticism +
        '\n\n## Your task now\n\n' +
        'Produce a corrected output that directly addresses the criticism above. ' +
        'Do not explain what you changed — just deliver the correct result.';
    }

    try {
      // Create ad-hoc agent: no tools, no extra personality — brief IS the system prompt
      const worker = new Agent({
        id: `run-worker-${input.preset}-${Date.now()}`,
        name: `Worker [${input.preset} / attempt ${input.attemptNumber}]`,
        // Minimal base instruction — the taskBrief carries all the specifics
        instructions: 'You are a focused executor. Follow the task brief exactly. Return only what is requested — nothing more.',
        model: modelId,
        mastra: mastra as any,
      });

      const result = await worker.generate(systemPrompt);

      // ── Phase 3.4: Report skill usage results ──
      if (loadedSkillNames.length > 0) {
        try {
          const registry = getSkillRegistry();
          for (const name of loadedSkillNames) {
            await registry.reportResult(name, true, 'Worker completed successfully');
          }
        } catch { /* non-critical */ }
      }

      return {
        output: result.text,
        model: modelId,
        attemptNumber: input.attemptNumber ?? 1,
        success: true,
        skillsLoaded: loadedSkillNames.length > 0 ? loadedSkillNames : undefined,
      };
    } catch (error) {
      // Report skill failure
      if (loadedSkillNames.length > 0) {
        try {
          const registry = getSkillRegistry();
          for (const name of loadedSkillNames) {
            await registry.reportResult(name, false, (error as Error).message);
          }
        } catch { /* non-critical */ }
      }

      // If local Ollama model failed, surface a clean error so meta can retry with 'cloud'
      return {
        output: '',
        model: modelId,
        attemptNumber: input.attemptNumber ?? 1,
        success: false,
        skillsLoaded: loadedSkillNames.length > 0 ? loadedSkillNames : undefined,
        error: (error as Error).message,
      };
    }
  },
});
