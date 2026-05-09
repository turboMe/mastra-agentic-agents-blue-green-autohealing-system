/**
 * System tool: delegate task to a specialized sub-agent.
 * Supports all registered agents by name + optional threadId for memory continuity.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { logAgentEvent } from '../../lib/agent-event-log.js';
import { marketingAgent } from '../../agents/marketing-agent.js';
import { salesAgent } from '../../agents/sales-agent.js';
import { analyticsAgent } from '../../agents/analytics-agent.js';
import { automationArchitect } from '../../agents/automation-architect.js';
import { crmAgent } from '../../agents/crm-agent.js';
import { codingAgent } from '../../agents/coding-agent.js';

const AGENTS_MAP = {
  marketingAgent,
  salesAgent,
  analyticsAgent,
  automationArchitect,
  crmAgent,
  codingAgent,
} as const;

type AgentKey = keyof typeof AGENTS_MAP;

export const delegateTaskTool = createTool({
  id: 'system.delegate_task',
  description: `Hand off a task to a domain EXPERT agent that has its own identity, tools, and memory.
Use this when the task requires the expert's TOOL STACK (Gmail, Calendar, n8n, CRM write paths, Pattern RAG).
For pure text-generation without side-effects, use system.run_worker instead — it's lighter and you control the full prompt.

Agents and their domains:
- marketingAgent  → Polish copy, cold-emails, producer-hunt, RSS digest, Gmail drafts (has Gmail + CRM + RSS tools)
- salesAgent      → CRM pipeline, proposals, onboarding, meeting scheduling (has CRM + Calendar + Gmail tools)
- analyticsAgent  → KPI reports, ROI, anomalies, trend analysis (has n8n monitoring + shared memory tools)
- automationArchitect → n8n workflow design, Pattern RAG, risk scoring, deploy with guardrails (has full n8n + Pattern RAG tools)
- crmAgent        → quick lead lookup only, runs on local model (read-only CRM, fast)
- codingAgent     → local repo work: read/search files, prepare patches, run safe verification commands (workspace tools with approval)

taskDescription should include:
  GOAL: what success looks like
  CONTEXT: background the agent needs (names, history, constraints)
  OUTPUT FORMAT: what you expect back (prose / JSON / markdown table)
  CONSTRAINTS: language, tone, length, what to avoid

CAN be called multiple times in parallel when tasks are independent.`,
  inputSchema: z.object({
    targetAgent: z.enum(['marketingAgent', 'salesAgent', 'analyticsAgent', 'automationArchitect', 'crmAgent', 'codingAgent'])
      .describe('Nazwa sub-agenta do którego delegujemy zadanie'),
    taskDescription: z.string().min(20).describe('Full task brief IN ENGLISH: GOAL + CONTEXT + OUTPUT FORMAT + CONSTRAINTS. The more explicit, the better the result from the sub-agent.'),
    threadId: z.string().optional().describe('ThreadId z Mastra Memory — przekaż gdy chcesz zachować ciągłość rozmowy z sub-agentem'),
    resourceId: z.string().optional().describe('ResourceId (np. userId) do segregacji pamięci'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.string(),
    agentUsed: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const agent = AGENTS_MAP[context.targetAgent as AgentKey];

    if (!agent) {
      return {
        success: false,
        result: `Agent "${context.targetAgent}" nie istnieje.`,
        agentUsed: context.targetAgent,
        error: `Dostępni agenci: ${Object.keys(AGENTS_MAP).join(', ')}`,
      };
    }

    try {
      const start = Date.now();
      const delegationThreadId = context.threadId || `delegation-${randomUUID()}`;
      const delegationResourceId = context.resourceId || 'meta-agent';

      const response = await agent.generate(
        context.taskDescription,
        {
          memory: {
            thread: delegationThreadId,
            resource: delegationResourceId,
          },
        },
      );

      logAgentEvent({
        type: 'delegation',
        agentId: context.targetAgent,
        status: 'success',
        input: context.taskDescription.slice(0, 500),
        output: response.text.slice(0, 500),
        durationMs: Date.now() - start,
      });

      return {
        success: true,
        result: response.text,
        agentUsed: context.targetAgent,
      };
    } catch (error) {
      logAgentEvent({
        type: 'delegation',
        agentId: context.targetAgent,
        status: 'error',
        input: context.taskDescription.slice(0, 500),
        errorMessage: (error as Error).message,
      });

      return {
        success: false,
        result: `Sub-agent zgłosił błąd: ${(error as Error).message}`,
        agentUsed: context.targetAgent,
        error: (error as Error).message,
      };
    }
  },
});
