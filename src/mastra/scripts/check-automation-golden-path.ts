#!/usr/bin/env tsx
import 'dotenv/config';
import { randomUUID } from 'crypto';

import { executeAutomationGoldenPath } from '../services/automation-golden-path.js';
import { N8nService } from '../tools/n8n/client.js';
import { getDb } from '../lib/mongo.js';

const unsafeWorkflow = {
  name: 'Unsafe Function Workflow',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'manual',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'unsafe',
      name: 'Unsafe Function',
      type: 'n8n-nodes-base.function',
      typeVersion: 1,
      position: [220, 0],
      parameters: {
        functionCode: "return [{ json: { out: $helpers.executeCommandSync('cat /etc/passwd').toString() } }];",
      },
    },
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Unsafe Function', type: 'main', index: 0 }]],
    },
  },
};

async function main() {
  const unsafeResult = await executeAutomationGoldenPath({
    mode: 'workflow_json',
    workflow: unsafeWorkflow,
    automationId: `check-unsafe-${Date.now()}`,
  });

  const securityCount = unsafeResult.validation?.securityIssues.length ?? 0;
  if (unsafeResult.status !== 'blocked' || securityCount === 0) {
    console.error(JSON.stringify(unsafeResult, null, 2));
    throw new Error('Unsafe workflow was not blocked by Golden Path validation.');
  }

  const automationId = `check-safe-${Date.now()}`;
  const safeResult = await executeAutomationGoldenPath({
    mode: 'workflow_json',
    automationId,
    workflow: {
      name: `Golden Path Check ${randomUUID().slice(0, 8)}`,
      active: false,
      settings: { executionOrder: 'v1' },
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    },
  });

  try {
    if (!safeResult.success || safeResult.status !== 'tested' || !safeResult.workflowId) {
      console.error(JSON.stringify(safeResult, null, 2));
      throw new Error('Safe workflow did not complete deploy + mock test.');
    }
  } finally {
    await cleanup(automationId, safeResult.workflowId);
  }

  console.log('automation-golden-path check passed');
  console.log(`unsafeStatus=${unsafeResult.status}, securityIssues=${securityCount}`);
  console.log(`safeStatus=${safeResult.status}, workflowId=${safeResult.workflowId}`);
  process.exit(0);
}

async function cleanup(automationId: string, workflowId?: string) {
  if (workflowId) {
    const n8n = new N8nService();
    await n8n.deleteWorkflow(workflowId).catch(() => undefined);
  }

  const db = await getDb();
  await db.collection('automation_requests').deleteOne({ automationId }).catch(() => undefined);
  await db.collection('automation_events').deleteMany({ automationId }).catch(() => undefined);
  await db.collection('automation_workflow_snapshots').deleteMany({ automationId }).catch(() => undefined);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
