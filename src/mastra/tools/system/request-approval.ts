/**
 * System tool: request human approval before executing a risky action.
 * Replaces: ApprovalManager.createPending() from jarvis approval-manager.ts.
 *
 * Agent calls this tool INSTEAD of the risky tool directly.
 * Dashboard shows pending approvals; user approves → agent re-runs with the approval resolved.
 * For workflow-level approvals use workflow.suspend() instead.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { randomUUID } from 'crypto';

export const requestApprovalTool = createTool({
  id: 'system.request_approval',
  description: 'Rejestruje prośbę o zatwierdzenie ryzykownej akcji (np. wysłanie emaila, deploy workflow, zmiana statusu). ZAWSZE używaj tego narzędzia zamiast bezpośredniego wywołania gdy akcja jest nieodwracalna i wymaga potwierdzenia użytkownika.',
  inputSchema: z.object({
    tool: z.string().describe('Nazwa narzędzia/akcji do zatwierdzenia, np. "gmail.send_draft"'),
    action: z.string().describe('Opis akcji dla użytkownika'),
    args: z.record(z.string(), z.unknown()).describe('Argumenty akcji, które zostaną przekazane po zatwierdzeniu'),
    agentId: z.string().optional().default('meta-agent').describe('ID agenta składającego prośbę'),
    taskId: z.string().optional().describe('ID zadania powiązanego'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    approvalId: z.string().optional(),
    status: z.literal('pending'),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const approvalId = randomUUID();
      await db.collection('approvals').insertOne({
        id: approvalId,
        agentId: context.agentId ?? 'meta-agent',
        taskId: context.taskId ?? null,
        tool: context.tool,
        action: context.action,
        args: context.args,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return {
        success: true,
        approvalId,
        status: 'pending' as const,
        message: `Prośba o zatwierdzenie zarejestrowana (ID: ${approvalId}). Poczekaj na zatwierdzenie przez użytkownika w dashboardzie.`,
      };
    } catch (error) {
      return {
        success: false,
        status: 'pending' as const,
        message: 'Błąd rejestracji prośby o zatwierdzenie',
        error: (error as Error).message,
      };
    }
  },
});
