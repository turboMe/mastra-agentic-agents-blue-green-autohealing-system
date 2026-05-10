import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { N8nService } from './client';

export const n8nTriggerWebhookTool = createTool({
  id: 'n8n_trigger',
  description: 'Uruchamia webhook w n8n wysyłając dane JSON. Używaj tego do inicjowania automatyzacji.',
  inputSchema: z.object({
    webhookPath: z.string().describe('Ścieżka webhooka (bez domeny), np. "moj-webhook-1"'),
    data: z.any().describe('Dane w formacie JSON do przekazania do webhooka'),
  }),
  execute: async (context) => {
    try {
      const n8n = new N8nService();
      const result = await n8n.triggerWebhook(context.webhookPath, context.data);
      return { success: true, data: result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const n8nHealthTool = createTool({
  id: 'n8n_health',
  description: 'Sprawdza, czy serwer n8n jest online i odpowiada.',
  inputSchema: z.object({}),
  execute: async () => {
    const n8n = new N8nService();
    const online = await n8n.getHealth();
    return { online };
  },
});

export const n8nListWorkflowsTool = createTool({
  id: 'n8n_list_workflows',
  description: 'Zwraca listę wszystkich dostępnych workflowów n8n w systemie (z ich ID i statusem aktywności).',
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const n8n = new N8nService();
      const workflows = await n8n.listWorkflows();
      return { success: true, count: workflows.length, workflows };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const n8nGetWorkflowTool = createTool({
  id: 'n8n_get_workflow',
  description: 'Pobiera pełną definicję (JSON) konkretnego workflowu po jego ID.',
  inputSchema: z.object({
    workflowId: z.string().describe('ID workflowu z n8n'),
  }),
  execute: async (context) => {
    try {
      const n8n = new N8nService();
      const workflow = await n8n.getWorkflow(context.workflowId);
      return { success: true, workflow };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const n8nUpdateWorkflowTool = createTool({
  id: 'n8n_update_workflow',
  description: 'Aktualizuje definicję istniejącego workflowu w n8n.',
  inputSchema: z.object({
    workflowId: z.string().describe('ID modyfikowanego workflowu z n8n'),
    workflowData: z.any().describe('Nowa definicja workflow (nodes, connections, settings)'),
  }),
  execute: async (context) => {
    try {
      const n8n = new N8nService();
      const workflow = await n8n.updateWorkflow(context.workflowId, context.workflowData);
      return { success: true, workflow };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const n8nActivateWorkflowTool = createTool({
  id: 'n8n_activate_workflow',
  description: 'Aktywuje workflow w n8n.',
  inputSchema: z.object({
    workflowId: z.string().describe('ID workflowu z n8n'),
  }),
  execute: async (context) => {
    try {
      const n8n = new N8nService();
      await n8n.activateWorkflow(context.workflowId);
      return { success: true, workflowId: context.workflowId, status: 'active' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const n8nDeactivateWorkflowTool = createTool({
  id: 'n8n_deactivate_workflow',
  description: 'Dezaktywuje workflow w n8n.',
  inputSchema: z.object({
    workflowId: z.string().describe('ID workflowu z n8n'),
  }),
  execute: async (context) => {
    try {
      const n8n = new N8nService();
      await n8n.deactivateWorkflow(context.workflowId);
      return { success: true, workflowId: context.workflowId, status: 'inactive' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});
