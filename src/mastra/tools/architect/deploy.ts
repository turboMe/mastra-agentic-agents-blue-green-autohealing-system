import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { N8nService } from '../n8n/client.js';
import { getDb } from '../../lib/mongo.js';
import { validateWorkflow, normalizeConnectionKeys } from './validation/workflow-validator.js';
import { analyzeWorkflow } from './risk-scoring.js';
import { randomUUID } from 'crypto';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { compactAutomationResultForModel } from '../../services/automation-output-compaction.js';

export const deployAutomationTool = createTool({
  id: 'architect_deploy_automation',
  description:
    'Tworzy lub aktualizuje workflow w n8n. Wykonuje automatyczna walidacje, risk scoring i sprawdza uprawnienia. Workflow zawsze tworzony jako inactive.',
  inputSchema: z.object({
    workflow: z.any().describe('Workflow JSON z architect.compose_workflow'),
    workflowId: z.string().optional().describe('ID workflow w n8n (dla update)'),
    automationId: z.string().optional().describe('Wewnętrzne ID automatyzacji Mastry'),
    approvalToken: z.string().optional().describe('ID zatwierdzonego approvala (wymagane dla risk >= 20)'),
    allowDraftWithMissingCredentials: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    automationId: z.string().optional(),
    workflowId: z.string().optional(),
    operation: z.enum(['create', 'update', 'blocked']).optional(),
    message: z.string(),
    error: z.string().optional(),
    validation: z.any().optional(),
    risk: z.any().optional(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    outputCompaction: z.any().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_deploy_automation',
    category: 'network',
    risk: 'high',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['workflow', 'approvalToken'],
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'deploy_automation' as const,
      target: input.workflowId ? `update:${input.workflowId}` : 'create:new',
      riskHint: 'high' as const,
    }),
    execute: async (context: any) => {
    const automationId = context.automationId || randomUUID();

    // 1. Best-effort fixup of obvious LLM mistakes in connection keys
    // (e.g. {"'Set Vars'": …} → {"Set Vars": …}). Runs before validation so
    // an otherwise correct workflow isn't rejected for cosmetic reasons.
    const normalizationWarnings = normalizeConnectionKeys(context.workflow);

    // 2. Deterministic validation. Missing credentials may still allow an inactive
    // draft, but structural and security errors never pass deploy.
    const validation = validateWorkflow(context.workflow, 'draft');
    if (normalizationWarnings.length > 0) {
      validation.warnings = [
        ...validation.warnings,
        ...normalizationWarnings.map((message) => ({ message, severity: 'warning' as const })),
      ];
    }
    const hasRequiredMissingCredentials = validation.missingCredentials.some((credential) => credential.required);
    const blocksDeploy =
      validation.errors.length > 0 ||
      validation.securityIssues.length > 0 ||
      (!context.allowDraftWithMissingCredentials && hasRequiredMissingCredentials);

    if (blocksDeploy) {
      return {
        success: false,
        operation: 'blocked' as const,
        message: 'Workflow validation failed. Fix structural/security errors before deploy.',
        validation,
      };
    }

    // 3. Risk scoring is always recalculated server-side.
    const riskResult = analyzeWorkflow(context.workflow);
    const score = riskResult.score;
    const verdict: 'approve' | 'review' | 'block' = score >= 80 ? 'block' : score >= 20 ? 'review' : 'approve';

    if (verdict === 'block') {
      return {
        success: false,
        operation: 'blocked' as const,
        message: `Deploy zablokowany — ryzyko zbyt wysokie (score=${score}). Napraw workflow.`,
        risk: { ...riskResult, verdict },
      };
    }

    if (verdict === 'review' && !context.approvalToken) {
      return {
        success: false,
        operation: 'blocked' as const,
        message: `Deploy wymaga approvala (risk score=${score}). Wywolaj system.request_approval i przekaż token po zatwierdzeniu.`,
        risk: { ...riskResult, verdict },
      };
    }

    const db = await getDb();

    // 4. Ownership check (for updates). Legacy or unmanaged workflows are read-only.
    if (context.workflowId) {
      const existing = await db.collection('automation_requests').findOne({ n8nWorkflowId: context.workflowId });
      if (!existing) {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Odmowa edycji: workflow ${context.workflowId} nie ma wpisu ownership Mastry. Utworz nowy draft albo przypisz ownership recznie.`,
        };
      }

      if (existing.managedBy !== 'mastra') {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Odmowa edycji: workflow ${context.workflowId} nie jest zarzadzany przez Mastre (managedBy=${existing.managedBy}).`,
        };
      }

      if (context.automationId && existing.automationId && existing.automationId !== context.automationId) {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Odmowa edycji: workflow ${context.workflowId} nalezy do automationId=${existing.automationId}, nie ${context.automationId}.`,
        };
      }
    }

    // 5. Approval check (jeśli review)
    if (verdict === 'review' && context.approvalToken) {
      const approval = await db.collection('approvals').findOne({ id: context.approvalToken });
      if (!approval || approval.status !== 'approved') {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Nieprawidlowy lub niezatwierdzony approvalToken: ${context.approvalToken}`,
        };
      }
    }

    // 6. Deploy to n8n (inactive=true)
    const payload = {
      ...context.workflow,
      name: context.workflow.name.startsWith('Mastra - ') ? context.workflow.name : `Mastra - ${context.workflow.name}`,
      active: false,
      settings: context.workflow.settings || { executionOrder: 'v1' },
    };

    try {
      const n8n = new N8nService();
      let n8nId = context.workflowId;
      let op: 'create' | 'update' = 'create';

      if (n8nId) {
        await n8n.updateWorkflow(n8nId, payload);
        op = 'update';
      } else {
        const created = await n8n.createWorkflow(payload);
        n8nId = created.id;
      }

      // 7. Audit Trail in Mongo
      await db.collection('automation_requests').updateOne(
        { automationId },
        {
          $set: {
            automationId,
            n8nWorkflowId: n8nId,
            name: payload.name,
            status: 'draft_created',
            riskScore: score,
            riskVerdict: verdict,
            managedBy: 'mastra',
            lastSnapshot: payload,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );

      return {
        success: true,
        automationId,
        workflowId: n8nId,
        operation: op,
        message: `Workflow ${op === 'create' ? 'utworzony' : 'zaktualizowany'} (id=${n8nId}). Status: inactive.`,
        validation,
        risk: { ...riskResult, verdict },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Blad komunikacji z n8n',
        error: (error as Error).message,
      };
    }
    },
    modelOutput: (output, _input, metadata) => compactAutomationResultForModel(output, metadata),
  }),
});
