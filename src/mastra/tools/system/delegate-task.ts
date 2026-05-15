/**
 * System tool: delegate task to a specialized sub-agent.
 * Supports all registered agents by name + optional threadId for memory continuity.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { logAgentEvent } from '../../lib/agent-event-log.js';
import { generateCoding } from '../../services/coding-harness.js';
import { generateAutomation } from '../../services/automation-harness.js';
import { generateKnowledge } from '../../services/knowledge-harness.js';
import { startAsyncDelegation } from '../../services/async-delegation.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  CODING_AGENT_ID,
  DELEGATION_CALLER_AGENT_IDS,
  DELEGATION_RETURN_AGENT_IDS,
  KNOWLEDGE_AGENT_ID,
  META_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../../config/agent-ids.js';

// Lazy-loaded to avoid circular: delegate-task → index → meta-agent → delegate-task
let _mastra: any = null;
async function getMastra() {
  if (!_mastra) {
    const mod = await import('../../index.js');
    _mastra = mod.mastra;
  }
  return _mastra;
}

// Mastra registry keys — must match the property names in `new Mastra({ agents: { ... } })`
// getAgent() looks up by property key, NOT by agent.id
const AGENT_IDS: Record<string, string> = {
  marketingAgent: 'marketingAgent',
  salesAgent: 'salesAgent',
  analyticsAgent: 'analyticsAgent',
  automationArchitect: AUTOMATION_ARCHITECT_AGENT_ID,
  knowledgeAgent: KNOWLEDGE_AGENT_ID,
  crmAgent: 'crmAgent',
  codingAgent: CODING_AGENT_ID,
} as const;

type AgentKey = keyof typeof AGENT_IDS;

export const delegateTaskTool = createTool({
  id: 'system_delegate_task',
  description: `Hand off a task to a domain EXPERT agent that has its own identity, tools, and memory.
Use this when the task requires the expert's TOOL STACK (Gmail, Calendar, n8n, CRM write paths, Pattern RAG).
For pure text-generation without side-effects, use system.run_worker instead — it's lighter and you control the full prompt.

Agents and their domains:
- marketingAgent  → Polish copy, cold-emails, producer-hunt, RSS digest, Gmail drafts (has Gmail + CRM + RSS tools)
- salesAgent      → CRM pipeline, proposals, onboarding, meeting scheduling (has CRM + Calendar + Gmail tools)
- analyticsAgent  → KPI reports, ROI, anomalies, trend analysis (has n8n monitoring + shared memory tools)
- automationArchitect → n8n workflow design, Pattern RAG, risk scoring, deploy with guardrails (has full n8n + Pattern RAG tools)
- knowledgeAgent  → Google NotebookLM research, notebook/source operations, cross-notebook Q&A, Studio artifacts (has NotebookLM MCP tools)
- crmAgent        → quick lead lookup only, runs on local model (read-only CRM, fast)
- codingAgent     → local repo work: read/search files, prepare patches, run safe verification commands (workspace tools with approval)

If the caller already has structured n8n Golden Path input or a complete workflow JSON, prefer system_start_automation_request instead of delegating a large JSON blob to automationArchitect as text.

taskDescription should include:
  GOAL: what success looks like
  CONTEXT: background the agent needs (names, history, constraints)
  OUTPUT FORMAT: what you expect back (prose / JSON / markdown table)
  CONSTRAINTS: language, tone, length, what to avoid

CAN be called multiple times in parallel when tasks are independent.`,
  inputSchema: z.object({
    targetAgent: z.enum(['marketingAgent', 'salesAgent', 'analyticsAgent', 'automationArchitect', 'knowledgeAgent', 'crmAgent', 'codingAgent'])
      .describe('Nazwa sub-agenta do którego delegujemy zadanie'),
    taskDescription: z.string().min(20).describe('Full task brief IN ENGLISH: GOAL + CONTEXT + OUTPUT FORMAT + CONSTRAINTS. The more explicit, the better the result from the sub-agent.'),
    threadId: z.string().optional().describe('ThreadId z Mastra Memory — przekaż gdy chcesz zachować ciągłość rozmowy z sub-agentem'),
    resourceId: z.string().optional().describe('ResourceId (np. userId) do segregacji pamięci'),
    async: z.boolean().optional().default(false).describe(
      'If true, delegate in background and return immediately. Use for long-running tasks like builds, tests, deploys, or scrapers. ' +
      'The result will be delivered automatically on the next user interaction. Supported for codingAgent, automationArchitect, and knowledgeAgent.',
    ),
    callerThreadId: z.string().optional().describe(
      'Your own threadId — required when async=true so the result can be delivered back to you.',
    ),
    callerAgentId: z.enum(DELEGATION_CALLER_AGENT_IDS).optional().default(META_AGENT_ID).describe(
      'Agent that should receive async pending results. Use automationArchitect when the architect delegates subtasks.',
    ),
    originAgentId: z.string().optional().describe('Original agent that initiated the delegation chain.'),
    originThreadId: z.string().optional().describe('Original thread that initiated the delegation chain.'),
    returnToAgentId: z.enum(DELEGATION_RETURN_AGENT_IDS).optional().describe(
      'Agent that should receive async results. Defaults to callerAgentId.',
    ),
    returnToThreadId: z.string().optional().describe('Thread that should receive async results. Defaults to callerThreadId.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.string(),
    agentUsed: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const agentId = AGENT_IDS[context.targetAgent as AgentKey];

    if (!agentId) {
      return {
        success: false,
        result: `Agent "${context.targetAgent}" nie istnieje.`,
        agentUsed: context.targetAgent,
        error: `Dostępni agenci: ${Object.keys(AGENT_IDS).join(', ')}`,
      };
    }

    const m = await getMastra();
    const agent = m.getAgent(agentId);
    if (!agent) {
      return {
        success: false,
        result: `Agent "${agentId}" not found in Mastra registry.`,
        agentUsed: context.targetAgent,
        error: `Agent registered but not resolved. Check mastra.agents config.`,
      };
    }

    try {
      const start = Date.now();
      const delegationThreadId = context.threadId || `delegation-${randomUUID()}`;
      const delegationResourceId = context.resourceId || META_AGENT_ID;
      const callerAgentId = canonicalizeRuntimeAgentId(context.callerAgentId) ?? META_AGENT_ID;
      const returnToAgentId = canonicalizeRuntimeAgentId(context.returnToAgentId ?? callerAgentId) ?? callerAgentId;
      const returnToThreadId = context.returnToThreadId ?? context.callerThreadId ?? context.threadId;
      const originAgentId = canonicalizeRuntimeAgentId(context.originAgentId ?? callerAgentId) ?? callerAgentId;
      const originThreadId = context.originThreadId ?? returnToThreadId;

      if (callerAgentId === AUTOMATION_ARCHITECT_AGENT_ID && context.targetAgent === 'automationArchitect') {
        return {
          success: false,
          result: 'automationArchitect cannot delegate recursively to itself.',
          agentUsed: context.targetAgent,
          error: 'recursive_delegation_blocked',
        };
      }
      if (callerAgentId === KNOWLEDGE_AGENT_ID && context.targetAgent === 'knowledgeAgent') {
        return {
          success: false,
          result: 'knowledgeAgent cannot delegate recursively to itself.',
          agentUsed: context.targetAgent,
          error: 'recursive_delegation_blocked',
        };
      }

      // ── Route codingAgent through harness for telemetry + precontext ──
      if (context.targetAgent === 'codingAgent') {
        // ── Async delegation: fire-and-forget for long-running tasks ──
        if (context.async) {
          const callerThread = context.callerThreadId || context.threadId || `meta-${randomUUID()}`;
          const { delegationId } = await startAsyncDelegation({
            agent,
            agentId: CODING_AGENT_ID,
            prompt: context.taskDescription,
            callerThreadId: callerThread,
            callerAgentId,
            originAgentId,
            originThreadId,
            targetAgentId: CODING_AGENT_ID,
            targetThreadId: `async-delegation-${randomUUID()}`,
            returnToAgentId,
            returnToThreadId: returnToThreadId ?? callerThread,
            repoPath: AGENTIC_AGENTS_REPO,
            timeoutMs: 300_000,
          });

          return {
            success: true,
            result: `Async delegation started. delegationId: ${delegationId}. ` +
              `The coding agent is working in the background. ` +
              `Results will be delivered automatically on the next user interaction.`,
            agentUsed: context.targetAgent,
          };
        }

        // ── Synchronous delegation (default): blocking await ──
        const harnessResult = await generateCoding({
          agent,
          agentId: CODING_AGENT_ID,
          prompt: context.taskDescription,
          threadId: delegationThreadId,
          phase: 'chat',
          repoPath: AGENTIC_AGENTS_REPO,
          timeoutMs: 300_000,
        });

        const responseText = harnessResult.outputPreview ?? '';

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: 'success',
          input: context.taskDescription.slice(0, 500),
          output: responseText.slice(0, 500),
          durationMs: Date.now() - start,
        });

        return {
          success: true,
          result: responseText,
          agentUsed: context.targetAgent,
        };
      }

      // ── Route automationArchitect through harness for telemetry + memory ──
      if (context.targetAgent === 'automationArchitect') {
        // ── Async delegation: fire-and-forget for long-running automation builds ──
        if (context.async) {
          const callerThread = context.callerThreadId || context.threadId || `meta-${randomUUID()}`;
          const { delegationId } = await startAsyncDelegation({
            agent,
            agentId: AUTOMATION_ARCHITECT_AGENT_ID,
            prompt: context.taskDescription,
            callerThreadId: callerThread,
            callerAgentId,
            originAgentId,
            originThreadId,
            targetAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
            targetThreadId: `async-delegation-${randomUUID()}`,
            returnToAgentId,
            returnToThreadId: returnToThreadId ?? callerThread,
            timeoutMs: 300_000,
          });

          return {
            success: true,
            result: `Async automation delegation started. delegationId: ${delegationId}. ` +
              `The automation architect is working in the background. ` +
              `Results will be delivered automatically on the next user interaction.`,
            agentUsed: context.targetAgent,
          };
        }

        // ── Synchronous delegation: blocking await through harness ──
        const harnessResult = await generateAutomation({
          agent,
          prompt: context.taskDescription,
          threadId: delegationThreadId,
          phase: 'chat',
          timeoutMs: 300_000,
        });

        const responseText = harnessResult.outputPreview ?? '';
        const automationContractOk = isAutomationArchitectContractComplete(responseText);

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: automationContractOk ? 'success' : 'error',
          input: context.taskDescription.slice(0, 500),
          output: responseText.slice(0, 500),
          durationMs: Date.now() - start,
          ...(automationContractOk
            ? {}
            : { errorMessage: 'automation_contract_missing', metadata: { contract: 'automation_golden_path' } }),
        });

        if (!automationContractOk) {
          return {
            success: false,
            result: responseText,
            agentUsed: context.targetAgent,
            error:
              'automation_contract_missing: automationArchitect must return a terminal status and automationId/workflowId when deploy/test succeeds.',
          };
        }

        return {
          success: true,
          result: responseText,
          agentUsed: context.targetAgent,
        };
      }

      // ── Route knowledgeAgent through harness for NotebookLM precontext + memory ──
      if (context.targetAgent === 'knowledgeAgent') {
        if (context.async) {
          const callerThread = context.callerThreadId || context.threadId || `meta-${randomUUID()}`;
          const { delegationId } = await startAsyncDelegation({
            agent,
            agentId: KNOWLEDGE_AGENT_ID,
            prompt: context.taskDescription,
            callerThreadId: callerThread,
            callerAgentId,
            originAgentId,
            originThreadId,
            targetAgentId: KNOWLEDGE_AGENT_ID,
            targetThreadId: `async-delegation-${randomUUID()}`,
            returnToAgentId,
            returnToThreadId: returnToThreadId ?? callerThread,
            timeoutMs: 300_000,
          });

          return {
            success: true,
            result: `Async NotebookLM delegation started. delegationId: ${delegationId}. ` +
              `The knowledge agent is working in the background. ` +
              `Results will be delivered automatically on the next user interaction.`,
            agentUsed: context.targetAgent,
          };
        }

        const harnessResult = await generateKnowledge({
          agent,
          prompt: context.taskDescription,
          threadId: delegationThreadId,
          phase: 'chat',
          timeoutMs: 300_000,
        });

        const responseText = harnessResult.outputPreview ?? '';

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: 'success',
          input: context.taskDescription.slice(0, 500),
          output: responseText.slice(0, 500),
          durationMs: Date.now() - start,
        });

        return {
          success: true,
          result: responseText,
          agentUsed: context.targetAgent,
        };
      }

      // ── All other agents: direct generate ──
      const response = await agent.generate( // @harness-exempt — non-coding/non-automation agents don't use harness
        context.taskDescription,
        {
          memory: {
            thread: delegationThreadId,
            resource: delegationResourceId,
          },
        },
      );

      const responseText = response.text ?? '';

      logAgentEvent({
        type: 'delegation',
        agentId: context.targetAgent,
        status: 'success',
        input: context.taskDescription.slice(0, 500),
        output: responseText.slice(0, 500),
        durationMs: Date.now() - start,
      });

      return {
        success: true,
        result: responseText,
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

function isAutomationArchitectContractComplete(text: string): boolean {
  const lower = text.toLowerCase();
  const hasTerminalStatus = /\b(blocked|draft_created|tested|active|manual_review_required)\b/i.test(text);
  if (!hasTerminalStatus) return false;

  const blocked = /\b(blocked|manual_review_required)\b/i.test(text);
  if (blocked) return true;

  return lower.includes('automationid') && lower.includes('workflowid');
}
