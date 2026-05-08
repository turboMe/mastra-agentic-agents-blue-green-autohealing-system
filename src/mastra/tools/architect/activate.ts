import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { N8nService } from '../n8n/client.js';
import { analyzeWorkflow } from './risk-scoring.js';
import { validateWorkflow } from './validation/workflow-validator.js';

type ActivationPolicy = {
  approvalRequired: boolean;
  reasons: string[];
};

export const activateAutomationTool = createTool({
  id: 'architect.activate_automation',
  description:
    'Aktywuje workflow n8n tylko jesli jest mastra-managed, przechodzi activation validation, risk scoring i activation policy.',
  inputSchema: z.object({
    automationId: z.string(),
    workflowId: z.string(),
    approvalToken: z.string().optional(),
    mode: z.enum(['auto', 'after_approval']).optional().default('auto'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    operation: z.enum(['activate', 'blocked']).optional(),
    automationId: z.string().optional(),
    workflowId: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
    validation: z.any().optional(),
    risk: z.any().optional(),
    activationPolicy: z.any().optional(),
  }),
  execute: async (context) => {
    const mode = context.mode ?? 'auto';
    const db = await getDb();
    const automation = await db.collection('automation_requests').findOne({ automationId: context.automationId });

    if (!automation) {
      return {
        success: false,
        operation: 'blocked' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: `Activation blocked: automationId=${context.automationId} not found.`,
      };
    }

    if (automation.managedBy !== 'mastra') {
      return {
        success: false,
        operation: 'blocked' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: `Activation blocked: automation is not managed by Mastra (managedBy=${automation.managedBy}).`,
      };
    }

    if (automation.n8nWorkflowId !== context.workflowId) {
      return {
        success: false,
        operation: 'blocked' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: `Activation blocked: workflowId mismatch. Expected ${automation.n8nWorkflowId}, received ${context.workflowId}.`,
      };
    }

    const n8n = new N8nService();
    let workflow: any;
    try {
      workflow = await n8n.getWorkflow(context.workflowId);
    } catch (error) {
      return {
        success: false,
        operation: 'blocked' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: 'Activation blocked: could not read workflow from n8n.',
        error: (error as Error).message,
      };
    }

    const validation = validateWorkflow(workflow, 'activation');
    if (
      !validation.valid ||
      validation.securityIssues.length > 0 ||
      validation.missingConfig.some((config) => config.required)
    ) {
      return {
        success: false,
        operation: 'blocked' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: 'Activation blocked: workflow failed activation validation.',
        validation,
      };
    }

    const riskResult = analyzeWorkflow(workflow);
    const score = riskResult.score;
    const verdict: 'approve' | 'review' | 'block' = score >= 80 ? 'block' : score >= 20 ? 'review' : 'approve';

    if (verdict === 'block') {
      return {
        success: false,
        operation: 'blocked' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: `Activation blocked: risk score=${score}.`,
        risk: { ...riskResult, verdict },
      };
    }

    const activationPolicy = evaluateActivationPolicy(workflow, score, mode);
    if (activationPolicy.approvalRequired && !context.approvalToken) {
      return {
        success: false,
        operation: 'blocked' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: `Activation requires approval: ${activationPolicy.reasons.join('; ')}`,
        risk: { ...riskResult, verdict },
        activationPolicy,
      };
    }

    if (activationPolicy.approvalRequired && context.approvalToken) {
      const approval = await db.collection('approvals').findOne({ id: context.approvalToken });
      if (!approval || approval.status !== 'approved') {
        return {
          success: false,
          operation: 'blocked' as const,
          automationId: context.automationId,
          workflowId: context.workflowId,
          message: `Invalid or unapproved approvalToken: ${context.approvalToken}`,
          activationPolicy,
        };
      }
    }

    try {
      await n8n.activateWorkflow(context.workflowId);
      await db.collection('automation_requests').updateOne(
        { automationId: context.automationId },
        {
          $set: {
            status: 'active',
            activatedAt: new Date(),
            updatedAt: new Date(),
            activationPolicy,
            activationValidation: validation,
            activationRisk: { ...riskResult, verdict },
          },
        },
      );

      return {
        success: true,
        operation: 'activate' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: `Workflow activated (id=${context.workflowId}).`,
        validation,
        risk: { ...riskResult, verdict },
        activationPolicy,
      };
    } catch (error) {
      return {
        success: false,
        operation: 'blocked' as const,
        automationId: context.automationId,
        workflowId: context.workflowId,
        message: 'Activation failed during n8n API call.',
        error: (error as Error).message,
      };
    }
  },
});

function evaluateActivationPolicy(workflow: any, score: number, mode: 'auto' | 'after_approval'): ActivationPolicy {
  const reasons: string[] = [];
  const nodes: any[] = Array.isArray(workflow.nodes) ? workflow.nodes : [];

  if (mode === 'after_approval') {
    reasons.push('activation mode requires approval');
  }

  if (score >= 20) {
    reasons.push(`risk score ${score} requires review`);
  }

  for (const node of nodes) {
    const type = String(node.type || '');
    const parameters = node.parameters || {};

    if (
      [
        'n8n-nodes-base.emailSend',
        'n8n-nodes-base.gmail',
        'n8n-nodes-base.slack',
        'n8n-nodes-base.mongoDb',
        'n8n-nodes-base.postgres',
      ].includes(type)
    ) {
      reasons.push(`node ${node.name || type} can write/send external data`);
    }

    if (type === 'n8n-nodes-base.httpRequest') {
      const method = String(parameters.method || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        reasons.push(`HTTP node ${node.name || type} uses method ${method}`);
      }
    }

    if (type === 'n8n-nodes-base.webhook') {
      const authentication = parameters.authentication || 'none';
      if (authentication === 'none') {
        reasons.push(`webhook ${node.name || type} has no authentication`);
      }
    }
  }

  return {
    approvalRequired: reasons.length > 0,
    reasons,
  };
}
