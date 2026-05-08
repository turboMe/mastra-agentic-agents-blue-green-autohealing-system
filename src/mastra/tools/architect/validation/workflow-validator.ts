import { ValidationFinding, ValidationResult, MissingCredential, MissingConfig } from './validation-types.js';
import { KNOWN_NODE_TYPES, TRIGGER_TYPES, FORBIDDEN_NODE_TYPES } from './node-registry.js';
import { getRuntimeTopology } from '../../../config/runtime-topology.js';

export function validateWorkflow(
  workflowJson: any,
  profile: 'draft' | 'strict' | 'activation' = 'strict',
): ValidationResult {
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  const securityIssues: ValidationFinding[] = [];
  const missingCredentials: MissingCredential[] = [];
  const missingConfig: MissingConfig[] = [];
  const topology = getRuntimeTopology();

  if (!workflowJson || typeof workflowJson !== 'object') {
    return createErrorResult('workflowJson is not a valid object', profile);
  }

  if (typeof workflowJson.name !== 'string' || !workflowJson.name.trim()) {
    errors.push({ message: 'Workflow missing non-empty "name" field.', severity: 'error' });
  }

  if (!Array.isArray(workflowJson.nodes)) {
    errors.push({ message: 'Workflow "nodes" must be an array.', severity: 'error' });
  }

  if (!workflowJson.connections || typeof workflowJson.connections !== 'object' || Array.isArray(workflowJson.connections)) {
    errors.push({ message: 'Workflow "connections" must be an object.', severity: 'error' });
  }

  if (workflowJson.active === true) {
    warnings.push({ message: 'Workflow has active=true; Mastra deploy will force inactive draft.', severity: 'warning' });
  }

  const nodes: any[] = Array.isArray(workflowJson.nodes) ? workflowJson.nodes : [];
  const connections: Record<string, any> =
    workflowJson.connections && typeof workflowJson.connections === 'object' && !Array.isArray(workflowJson.connections)
      ? workflowJson.connections
      : {};

  if (nodes.length === 0) {
    errors.push({ message: 'Workflow has no nodes.', severity: 'error' });
  }

  const nodeNames = new Set<string>();
  const nodeIds = new Set<string>();
  const allNodeNames = new Set(nodes.map((node) => node?.name).filter((name): name is string => typeof name === 'string' && name.length > 0));
  let hasTrigger = false;
  let connectionCount = 0;

  for (const node of nodes) {
    // 1. Basic fields
    if (!node.name) errors.push({ message: 'Node missing "name" field', severity: 'error' });
    if (!node.type) errors.push({ message: `Node "${node.name || 'unknown'}" missing "type" field`, severity: 'error' });
    if (!node.id) warnings.push({ nodeName: node.name, message: 'Node missing "id"', severity: 'warning' });
    if (node.typeVersion === undefined)
      warnings.push({ nodeName: node.name, message: 'Node missing "typeVersion"', severity: 'warning' });
    if (!Array.isArray(node.position) || node.position.length !== 2) {
      warnings.push({ nodeName: node.name, message: 'Node missing valid [x,y] position', severity: 'warning' });
    }

    if (node.type) {
      const knownVersions = KNOWN_NODE_TYPES[node.type];
      if (!knownVersions) {
        warnings.push({ nodeName: node.name, message: `Unknown node type: ${node.type}`, severity: 'warning' });
      } else if (node.typeVersion !== undefined && !knownVersions.includes(Number(node.typeVersion))) {
        warnings.push({
          nodeName: node.name,
          message: `Unexpected typeVersion ${node.typeVersion} for ${node.type}. Known: ${knownVersions.join(', ')}`,
          severity: 'warning',
        });
      }
    }

    // 2. Uniqueness
    if (node.name && nodeNames.has(node.name)) {
      errors.push({ nodeName: node.name, message: `Duplicate node name: "${node.name}"`, severity: 'error' });
    }
    if (node.name) nodeNames.add(node.name);

    if (node.id && nodeIds.has(node.id)) {
      warnings.push({ nodeName: node.name, message: `Duplicate node id: "${node.id}"`, severity: 'warning' });
    }
    if (node.id) nodeIds.add(node.id);

    // 3. Trigger check
    if (TRIGGER_TYPES.has(node.type)) {
      hasTrigger = true;
    }

    // 4. Forbidden node check
    if (node.type && FORBIDDEN_NODE_TYPES.includes(node.type)) {
      securityIssues.push({ nodeName: node.name, message: `Node uses forbidden type: ${node.type}`, severity: 'security' });
    }

    // 5. Parameters & Security
    if (node.parameters) {
      const paramStr = JSON.stringify(node.parameters);

      // No $vars.*
      if (/\$vars\./.test(paramStr)) {
        errors.push({
          nodeName: node.name,
          message: 'Uses $vars.* which is not supported in n8n Community Edition.',
          severity: 'error',
        });
      }

      // No [object Object]
      if (paramStr.includes('"[object Object]"') || paramStr.includes('[object Object]')) {
        errors.push({
          nodeName: node.name,
          message: 'Contains invalid "[object Object]" in parameters.',
          severity: 'error',
        });
      }

      // Runtime placeholders
      const placeholders = ['example.com', 'placeholder', 'GastroBridge'];
      for (const p of placeholders) {
        if (paramStr.includes(p) && !paramStr.includes('={{')) {
          warnings.push({
            nodeName: node.name,
            message: `Contains placeholder value: "${p}"`,
            severity: 'warning',
          });
        }
      }

      if (paramStr.includes('http://localhost:3000') && process.env.ALLOW_LEGACY_LOCALHOST_3000 !== 'true') {
        errors.push({
          nodeName: node.name,
          message: 'Uses legacy Jarvis endpoint http://localhost:3000. Use MASTRA_API_URL_FOR_N8N / runtime topology instead.',
          severity: 'error',
        });
      }

      if (topology.mode === 'local-host-network' && paramStr.includes('af-mongodb')) {
        errors.push({
          nodeName: node.name,
          message: 'Uses docker service hostname af-mongodb while runtime mode is local-host-network. Use localhost:27017 or MONGO_HOST_FOR_N8N.',
          severity: 'error',
        });
      }

      if (topology.mode === 'local-host-network' && paramStr.includes('host.docker.internal')) {
        warnings.push({
          nodeName: node.name,
          message: 'Uses host.docker.internal in local-host-network mode. Prefer localhost endpoints from runtime topology.',
          severity: 'warning',
        });
      }

      for (const value of collectStringValues(node.parameters)) {
        if (hasUnbalancedExpression(value)) {
          errors.push({
            nodeName: node.name,
            message: `Expression appears unbalanced: ${truncate(value)}`,
            severity: 'error',
          });
        }

        for (const referencedName of findExpressionNodeRefs(value)) {
          if (!allNodeNames.has(referencedName)) {
            errors.push({
              nodeName: node.name,
              message: `Expression references unknown node: "${referencedName}"`,
              severity: 'error',
            });
          }
        }
      }

      // Security: eval/Function
      if (node.type === 'n8n-nodes-base.code' && node.parameters.jsCode) {
        if (/\beval\s*\(/.test(node.parameters.jsCode)) {
          securityIssues.push({ nodeName: node.name, message: 'Uses eval() - risk of injection', severity: 'security' });
        }
        if (/\bnew\s+Function\s*\(/.test(node.parameters.jsCode)) {
          securityIssues.push({
            nodeName: node.name,
            message: 'Uses new Function() - risk of injection',
            severity: 'security',
          });
        }
        if (/require\s*\(\s*['"]child_process['"]\s*\)/.test(node.parameters.jsCode)) {
          securityIssues.push({ nodeName: node.name, message: 'Uses child_process in code node', severity: 'security' });
        }
        if (/require\s*\(\s*['"]fs['"]\s*\)/.test(node.parameters.jsCode)) {
          securityIssues.push({ nodeName: node.name, message: 'Uses fs module in code node', severity: 'security' });
        }
      }
    }

    // 6. Credentials
    const credentialRequirements: Record<string, { service: string; credentialTypes: string[] }> = {
      'n8n-nodes-base.telegram': { service: 'telegram', credentialTypes: ['telegramApi'] },
      'n8n-nodes-base.telegramTrigger': { service: 'telegram', credentialTypes: ['telegramApi'] },
      'n8n-nodes-base.mongoDb': { service: 'mongo', credentialTypes: ['mongoDb'] },
      'n8n-nodes-base.gmail': { service: 'gmail', credentialTypes: ['googleGmailOAuth2Api', 'gmailOAuth2'] },
      'n8n-nodes-base.gmailTrigger': { service: 'gmail', credentialTypes: ['googleGmailOAuth2Api', 'gmailOAuth2'] },
    };
    const credentialRequirement = credentialRequirements[node.type];
    const hasCredential = credentialRequirement?.credentialTypes.some((credentialType) => node.credentials?.[credentialType]);
    if (credentialRequirement && !hasCredential) {
      missingCredentials.push({
        service: credentialRequirement.service,
        required: true,
        setupHint: `Brakuje credentiala (${credentialRequirement.credentialTypes.join(' lub ')}) dla ${node.type}`,
      });
    }

    if (node.type === 'n8n-nodes-base.telegram' && node.parameters?.chatId === '') {
      missingConfig.push({
        key: 'N8N_TELEGRAM_CHAT_ID',
        description: 'Telegram send node has empty chatId.',
        required: true,
      });
    }
  }

  // 7. Connections
  for (const [sourceName, sourceConnections] of Object.entries(connections)) {
    if (!nodeNames.has(sourceName)) {
      errors.push({ message: `Connection references unknown source node: "${sourceName}"`, severity: 'error' });
    }

    const main = (sourceConnections as any)?.main;
    if (!Array.isArray(main)) continue;

    for (const outputGroup of main) {
      if (!Array.isArray(outputGroup)) continue;
      for (const conn of outputGroup) {
        connectionCount++;
        if (!conn.node) {
          errors.push({ message: `Connection from "${sourceName}" has missing target node`, severity: 'error' });
        } else if (!nodeNames.has(conn.node)) {
          errors.push({
            message: `Connection from "${sourceName}" references unknown target: "${conn.node}"`,
            severity: 'error',
          });
        }
      }
    }
  }

  // 8. Profile-specific logic
  let isValid = errors.length === 0;

  if (profile === 'strict' || profile === 'activation') {
    if (securityIssues.length > 0) isValid = false;
    if (missingCredentials.some((c) => c.required)) isValid = false;
    if (missingConfig.some((c) => c.required)) isValid = false;
  }

  if (profile === 'activation') {
    if (!hasTrigger) {
      errors.push({ message: 'Activation profile requires a trigger node.', severity: 'error' });
      isValid = false;
    }
  }

  return {
    valid: isValid,
    profile,
    errors,
    warnings,
    securityIssues,
    missingCredentials,
    missingConfig,
    nodeCount: nodes.length,
    connectionCount,
  };
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStringValues(item));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) => collectStringValues(item));
  }
  return [];
}

function hasUnbalancedExpression(value: string): boolean {
  if (!value.includes('={{')) return false;
  const opened = (value.match(/=\{\{/g) || []).length;
  const closed = (value.match(/\}\}/g) || []).length;
  return opened !== closed;
}

function findExpressionNodeRefs(value: string): string[] {
  const refs = new Set<string>();
  const patterns = [/\$\(['"]([^'"]+)['"]\)/g, /\$node\[['"]([^'"]+)['"]\]/g, /\$items\(['"]([^'"]+)['"]/g];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      refs.add(match[1]);
    }
  }

  return [...refs];
}

function truncate(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function createErrorResult(message: string, profile: any): ValidationResult {
  return {
    valid: false,
    profile,
    errors: [{ message, severity: 'error' }],
    warnings: [],
    securityIssues: [],
    missingCredentials: [],
    missingConfig: [],
    nodeCount: 0,
    connectionCount: 0,
  };
}
