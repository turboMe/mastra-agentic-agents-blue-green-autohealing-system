export type N8nWorkflowSummary = {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};

export type N8nExecutionSummary = {
  id: string;
  workflowId?: string;
  status?: string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string;
};

export type N8nWorkflowDefinition = {
  id?: string;
  name: string;
  active: boolean;
  nodes: any[];
  connections: any;
  settings?: any;
  staticData?: any;
  meta?: any;
  tags?: any[];
};

export class N8nService {
  private baseUrl: string;
  private apiKey?: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string }) {
    this.baseUrl = opts?.baseUrl ?? process.env.N8N_BASE_URL ?? process.env.N8N_URL ?? 'http://localhost:5678';
    this.apiKey = opts?.apiKey ?? process.env.N8N_API_KEY;
  }

  private redactError(message: string): string {
    if (!message) return message;
    let redacted = message;
    redacted = redacted.replace(/eyJ[a-zA-Z0-9._-]+/g, '[REDACTED_TOKEN]');
    if (this.apiKey) {
      redacted = redacted.replace(new RegExp(this.apiKey, 'g'), '[REDACTED_API_KEY]');
    }
    return redacted;
  }

  async triggerWebhook(path: string, data: any): Promise<any> {
    const url = `${this.baseUrl}/webhook/${path}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(30_000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`n8n webhook ${path} failed (${res.status}): ${text.slice(0, 200)}`);
      }

      return res.json().catch(() => ({ ok: true }));
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async listWorkflows(): Promise<N8nWorkflowSummary[]> {
    if (!this.apiKey) return [];

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/workflows`, {
        headers: { 'X-N8N-API-KEY': this.apiKey },
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        throw new Error(`n8n listWorkflows failed: ${res.status}`);
      }

      const json = await res.json() as any;
      return (json.data ?? []).map((w: any) => ({
        id: w.id,
        name: w.name,
        active: w.active ?? false,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        tags: (w.tags ?? []).map((t: any) => t.name ?? t)
      }));
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async getWorkflow(workflowId: string): Promise<N8nWorkflowDefinition> {
    if (!this.apiKey) throw new Error('N8N_API_KEY required for getWorkflow');

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/workflows/${workflowId}`, {
        headers: { 'X-N8N-API-KEY': this.apiKey },
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        throw new Error(`n8n getWorkflow ${workflowId} failed: ${res.status}`);
      }

      return res.json() as Promise<N8nWorkflowDefinition>;
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async createWorkflow(workflowData: Partial<N8nWorkflowDefinition>): Promise<N8nWorkflowDefinition> {
    if (!this.apiKey) throw new Error('N8N_API_KEY required for createWorkflow');

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/workflows`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-N8N-API-KEY': this.apiKey
        },
        body: JSON.stringify(workflowData),
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`n8n createWorkflow failed (${res.status}): ${text.slice(0, 200)}`);
      }

      return res.json() as Promise<N8nWorkflowDefinition>;
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async updateWorkflow(workflowId: string, workflowData: Partial<N8nWorkflowDefinition>): Promise<N8nWorkflowDefinition> {
    if (!this.apiKey) throw new Error('N8N_API_KEY required for updateWorkflow');

    try {
      const data = { ...workflowData };
      delete data.active; 

      const res = await fetch(`${this.baseUrl}/api/v1/workflows/${workflowId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-N8N-API-KEY': this.apiKey
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`n8n updateWorkflow ${workflowId} failed (${res.status}): ${text.slice(0, 200)}`);
      }

      return res.json() as Promise<N8nWorkflowDefinition>;
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async activateWorkflow(workflowId: string): Promise<void> {
    if (!this.apiKey) throw new Error('N8N_API_KEY required for activateWorkflow');

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/workflows/${workflowId}/activate`, {
        method: 'POST',
        headers: { 'X-N8N-API-KEY': this.apiKey },
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`n8n activateWorkflow ${workflowId} failed (${res.status}): ${text.slice(0, 200)}`);
      }
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async deactivateWorkflow(workflowId: string): Promise<void> {
    if (!this.apiKey) throw new Error('N8N_API_KEY required for deactivateWorkflow');

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/workflows/${workflowId}/deactivate`, {
        method: 'POST',
        headers: { 'X-N8N-API-KEY': this.apiKey },
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`n8n deactivateWorkflow ${workflowId} failed (${res.status}): ${text.slice(0, 200)}`);
      }
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async deleteWorkflow(workflowId: string): Promise<boolean> {
    if (!this.apiKey) throw new Error('N8N_API_KEY required for deleteWorkflow');

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/workflows/${workflowId}`, {
        method: 'DELETE',
        headers: { 'X-N8N-API-KEY': this.apiKey },
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        throw new Error(`n8n deleteWorkflow ${workflowId} failed: ${res.status}`);
      }

      return true;
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async getExecutions(params?: { limit?: number; workflowId?: string }): Promise<N8nExecutionSummary[]> {
    if (!this.apiKey) return [];

    try {
      const url = new URL(`${this.baseUrl}/api/v1/executions`);
      if (params?.limit) url.searchParams.append('limit', params.limit.toString());
      if (params?.workflowId) url.searchParams.append('workflowId', params.workflowId);

      const res = await fetch(url.toString(), {
        headers: { 'X-N8N-API-KEY': this.apiKey },
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        throw new Error(`n8n getExecutions failed: ${res.status}`);
      }

      const json = await res.json() as any;
      return json.data ?? [];
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async getExecution(executionId: string): Promise<any> {
    if (!this.apiKey) throw new Error('N8N_API_KEY required for getExecution');

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/executions/${executionId}`, {
        headers: { 'X-N8N-API-KEY': this.apiKey },
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        throw new Error(`n8n getExecution ${executionId} failed: ${res.status}`);
      }

      return res.json();
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async executeWorkflow(workflowId: string, data?: any): Promise<any> {
    if (!this.apiKey) throw new Error('N8N_API_KEY required for executeWorkflow');

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/workflows/${workflowId}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-N8N-API-KEY': this.apiKey
        },
        body: JSON.stringify({ data: data ?? {} }),
        signal: AbortSignal.timeout(60_000)
      });

      if (!res.ok) {
        throw new Error(`n8n executeWorkflow ${workflowId} failed: ${res.status}`);
      }

      return res.json();
    } catch (err) {
      throw new Error(this.redactError((err as Error).message));
    }
  }

  async getHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(3_000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  getEditorUrl(): string {
    return this.baseUrl;
  }
}
