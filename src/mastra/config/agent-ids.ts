export const META_AGENT_ID = 'meta-agent' as const;

/**
 * Canonical runtime/telemetry id for Automation Architect.
 *
 * Mastra's public Agent.id is still `automation-architect` for API/thread
 * compatibility; new harness telemetry, pending messages, and durable jobs use
 * `automationArchitect`.
 */
export const AUTOMATION_ARCHITECT_AGENT_ID = 'automationArchitect' as const;
export const AUTOMATION_ARCHITECT_MASTRA_AGENT_ID = 'automation-architect' as const;

export const CODING_AGENT_ID = 'codingAgent' as const;
export const CODING_AGENT_MASTRA_AGENT_ID = 'coding-agent' as const;

export const CODE_REVIEW_AGENT_ID = 'codeReviewAgent' as const;
export const CODE_REVIEW_AGENT_MASTRA_AGENT_ID = 'code-review-agent' as const;

export const KNOWLEDGE_AGENT_ID = 'knowledgeAgent' as const;
export const KNOWLEDGE_AGENT_MASTRA_AGENT_ID = 'knowledge-agent' as const;

export const DELIBERATION_AGENT_ID = 'deliberationAgent' as const;
export const DELIBERATION_AGENT_MASTRA_AGENT_ID = 'deliberation-agent' as const;

export const AUTOMATION_ARCHITECT_AGENT_ALIASES = [
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
] as const;

export const CODING_AGENT_ALIASES = [
  CODING_AGENT_ID,
  CODING_AGENT_MASTRA_AGENT_ID,
] as const;

export const CODE_REVIEW_AGENT_ALIASES = [
  CODE_REVIEW_AGENT_ID,
  CODE_REVIEW_AGENT_MASTRA_AGENT_ID,
] as const;

export const KNOWLEDGE_AGENT_ALIASES = [
  KNOWLEDGE_AGENT_ID,
  KNOWLEDGE_AGENT_MASTRA_AGENT_ID,
] as const;

export const DELIBERATION_AGENT_ALIASES = [
  DELIBERATION_AGENT_ID,
  DELIBERATION_AGENT_MASTRA_AGENT_ID,
] as const;

export const PENDING_UPDATES_AGENT_IDS = [
  META_AGENT_ID,
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  CODING_AGENT_ID,
] as const;

export const DELEGATION_CALLER_AGENT_IDS = [
  META_AGENT_ID,
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  DELIBERATION_AGENT_ID,
] as const;

export const DELEGATION_RETURN_AGENT_IDS = [
  META_AGENT_ID,
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  CODING_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  DELIBERATION_AGENT_ID,
] as const;

export function canonicalizeRuntimeAgentId(agentId: string | null | undefined): string | undefined {
  if (!agentId) return undefined;
  if ((AUTOMATION_ARCHITECT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return AUTOMATION_ARCHITECT_AGENT_ID;
  }
  if ((CODING_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return CODING_AGENT_ID;
  }
  if ((CODE_REVIEW_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return CODE_REVIEW_AGENT_ID;
  }
  if ((KNOWLEDGE_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return KNOWLEDGE_AGENT_ID;
  }
  if ((DELIBERATION_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return DELIBERATION_AGENT_ID;
  }
  return agentId;
}

export function agentIdAliases(agentId: string | null | undefined): string[] {
  if (!agentId) return [];
  if ((AUTOMATION_ARCHITECT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...AUTOMATION_ARCHITECT_AGENT_ALIASES];
  }
  if ((CODING_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...CODING_AGENT_ALIASES];
  }
  if ((CODE_REVIEW_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...CODE_REVIEW_AGENT_ALIASES];
  }
  if ((KNOWLEDGE_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...KNOWLEDGE_AGENT_ALIASES];
  }
  if ((DELIBERATION_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...DELIBERATION_AGENT_ALIASES];
  }
  return [agentId];
}

export function agentIdFieldFilter(agentId: string | null | undefined): string | { $in: string[] } | undefined {
  const aliases = agentIdAliases(agentId);
  if (aliases.length === 0) return undefined;
  return aliases.length === 1 ? aliases[0] : { $in: aliases };
}

export function pendingTargetAgentQuery(agentId: string | null | undefined): Record<string, unknown> {
  const targetFilter = agentIdFieldFilter(agentId);
  if (!targetFilter) return {};
  return {
    $or: [
      { targetAgentId: targetFilter },
      { targetAgentId: { $exists: false } },
      { targetAgentId: null },
    ],
  };
}
