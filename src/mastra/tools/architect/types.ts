/**
 * Automation Architect type definitions.
 *
 * Ported from jarvis-dashboard-agent/packages/automation-architect/src/types
 * and patterns/patternTypes.ts. Consolidated into a single local file so the
 * tools/architect tree is self-contained (no @af/... workspace imports).
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type AutomationSpec = {
  id: string;
  requestId: string;
  name: string;
  description: string;
  goal: string;
  trigger: {
    type: 'manual' | 'schedule' | 'webhook' | 'email' | 'external_event';
    schedule?: {
      frequency: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly';
      time?: string;
      timezone: string;
      cron?: string;
    };
    webhook?: {
      method: 'GET' | 'POST';
      expectedPayloadDescription: string;
    };
  };
  inputs: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'url' | 'secret' | 'json';
    required: boolean;
    description: string;
  }>;
  steps: Array<{
    id: string;
    name: string;
    purpose: string;
    actionType: 'read' | 'transform' | 'condition' | 'notify' | 'write' | 'send' | 'delete' | 'execute';
    expectedInput?: string;
    expectedOutput?: string;
    failureBehavior?: 'stop' | 'continue' | 'retry' | 'notify_user';
  }>;
  externalServices?: string[];
  credentialsNeeded?: Array<{
    service: string;
    credentialName?: string;
    required: boolean;
    notes?: string;
  }>;
  dataPolicy?: {
    readsExternalData?: boolean;
    writesExternalData?: boolean;
    sendsMessages?: boolean;
    touchesCustomerData?: boolean;
    touchesProductionDb?: boolean;
    usesPaidApi?: boolean;
    usesFileSystem?: boolean;
    usesShellCommand?: boolean;
  };
  successCriteria?: string[];
  riskLevel?: RiskLevel;
  requiresApproval?: boolean;
  missingConfig?: Array<{
    key: string;
    description: string;
    required: boolean;
  }>;
};

export type AutomationPatternRisk = RiskLevel;

export type AutomationPattern = {
  id: string;
  name: string;
  description: string;
  risk: AutomationPatternRisk;
  supportedIntents: string[];
  requiredInputs: string[];
  requiredCredentials: string[];
  forbiddenWithoutApproval: boolean;
  build: (spec: AutomationSpec) => any;
  knowledgeCard?: PatternKnowledgeCard;
};

export type PatternKnowledgeCard = {
  id: string;
  name: string;
  intentExamples: string[];
  useWhen: string[];
  avoidWhen: string[];
  preferredModel?: 'gemma4-26b' | 'qwen35b' | 'gemini';
  risk: RiskLevel;
  nodes: string[];
  credentials: string[];
  approvalRequired: boolean;
  testingStrategy: string[];
  commonFailures: string[];
  fallbackStrategy?: string[];
};

export type StoredAutomationPattern = Omit<AutomationPattern, 'build'> & {
  builderId: string;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
};

export type AutomationDecisionRule = {
  id: string;
  rule: string;
  reason: string;
};

export type ModelChoice = {
  provider: 'ollama' | 'gemini_gateway';
  model: string;
  reason: string;
};
