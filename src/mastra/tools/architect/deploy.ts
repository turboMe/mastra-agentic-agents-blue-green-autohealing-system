/**
 * Deploy Automation: tworzy lub aktualizuje workflow w n8n.
 *
 * GUARDRAILS (NIENARUSZALNE):
 * - Wymaga `riskVerdict` na wejściu — agent musi wcześniej wywołać architect.risk_score.
 * - verdict='block' → odmowa deploya, zawsze.
 * - verdict='review' → wymaga `approvalToken` (zwracane przez system.request_approval po zatwierdzeniu).
 * - active = false zawsze (aktywacja przez n8n.activate_workflow w osobnym kroku).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { N8nService } from '../n8n/client.js';
import { getDb } from '../../lib/mongo.js';

export const deployAutomationTool = createTool({
  id: 'architect.deploy_automation',
  description:
    'Tworzy lub aktualizuje workflow w n8n. Wymaga wcześniejszego risk_score. Workflow zawsze tworzony jako inactive — aktywuj osobno.',
  inputSchema: z.object({
    workflow: z
      .object({
        name: z.string(),
        nodes: z.array(z.unknown()),
        connections: z.record(z.string(), z.unknown()),
        settings: z.record(z.string(), z.unknown()).optional(),
      })
      .describe('Output z architect.compose_workflow'),
    riskVerdict: z
      .enum(['approve', 'review', 'block'])
      .describe('Werdykt z architect.risk_score'),
    riskScore: z.number().describe('Liczbowy score z architect.risk_score'),
    approvalToken: z
      .string()
      .optional()
      .describe('approvalId zwrócony przez system.request_approval po zatwierdzeniu — wymagany gdy verdict=review'),
    workflowId: z
      .string()
      .optional()
      .describe('Jeśli podane → update istniejącego workflow, w przeciwnym razie create nowego.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    workflowId: z.string().optional(),
    operation: z.enum(['create', 'update', 'blocked']).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    // Guardrail 1: block
    if (context.riskVerdict === 'block') {
      return {
        success: false,
        operation: 'blocked' as const,
        message: `Deploy zablokowany — risk_score=${context.riskScore} verdict=block. Napraw workflow i powtórz risk_score.`,
      };
    }

    // Guardrail 2: review wymaga zatwierdzonego approvalToken
    if (context.riskVerdict === 'review') {
      if (!context.approvalToken) {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Deploy wymaga approvalToken (verdict=review, score=${context.riskScore}). Wywołaj system.request_approval i przekaż approvalId po zatwierdzeniu.`,
        };
      }
      try {
        const db = await getDb();
        const approval = await db.collection('approvals').findOne({ id: context.approvalToken });
        if (!approval) {
          return {
            success: false,
            operation: 'blocked' as const,
            message: `Nieprawidłowy approvalToken: ${context.approvalToken}`,
          };
        }
        if (approval.status !== 'approved') {
          return {
            success: false,
            operation: 'blocked' as const,
            message: `Approval nie został zatwierdzony (status=${approval.status}).`,
          };
        }
      } catch (e) {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Błąd walidacji approvalToken: ${(e as Error).message}`,
        };
      }
    }

    // Force active=false zawsze
    const payload = {
      name: context.workflow.name,
      nodes: context.workflow.nodes as any,
      connections: context.workflow.connections as any,
      settings: (context.workflow.settings ?? { executionOrder: 'v1' }) as any,
      active: false,
    };

    try {
      const n8n = new N8nService();
      if (context.workflowId) {
        const updated = await n8n.updateWorkflow(context.workflowId, payload as any);
        return {
          success: true,
          workflowId: context.workflowId,
          operation: 'update' as const,
          message: `Workflow zaktualizowany: ${updated.name}. Status: inactive. Aktywuj przez n8n.activate_workflow.`,
        };
      }
      const created = await n8n.createWorkflow(payload as any);
      return {
        success: true,
        workflowId: created.id,
        operation: 'create' as const,
        message: `Workflow utworzony: ${created.name} (id=${created.id}). Status: inactive. Aktywuj przez n8n.activate_workflow.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Błąd deploya do n8n',
        error: (error as Error).message,
      };
    }
  },
});
