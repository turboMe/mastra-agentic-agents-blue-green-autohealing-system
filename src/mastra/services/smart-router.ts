/**
 * Smart Model Router
 *
 * Assigns optimal models to subtasks based on complexity, available GPU slots,
 * and cost optimization. Builds parallel execution groups from dependency graph.
 *
 * Flow: diagnosticPlan.subtasks → assignModels() → subtasks with assignedModel + parallelGroup
 */
import {
  type ModelCapability,
  type TaskComplexity,
  modelRegistry,
  complexityMeetsRequirement,
  VRAM_BUDGET_MB,
} from '../config/model-capabilities.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoutableSubtask {
  id: string;
  estimatedComplexity?: TaskComplexity;
  dependencies: string[];
  targetFiles: string[];
  type: string;
  // Populated by router:
  assignedModel?: string;
  parallelGroup?: number;
  estimatedVramMb?: number;
}

interface RouteDecision {
  subtaskId: string;
  model: ModelCapability;
  reason: string;
}

// ── Slot Manager ─────────────────────────────────────────────────────────────

/**
 * Tracks VRAM usage across concurrent local model assignments.
 * Cloud models have unlimited slots (rate limited by API).
 */
class VramBudgetTracker {
  private usedVramMb = 0;
  private readonly budgetMb: number;

  constructor(budgetMb: number = VRAM_BUDGET_MB) {
    this.budgetMb = budgetMb;
  }

  canFit(model: ModelCapability): boolean {
    if (model.vramMb === 0) return true; // Cloud
    return this.usedVramMb + model.vramMb <= this.budgetMb;
  }

  allocate(model: ModelCapability): void {
    this.usedVramMb += model.vramMb;
  }

  release(model: ModelCapability): void {
    this.usedVramMb = Math.max(0, this.usedVramMb - model.vramMb);
  }

  reset(): void {
    this.usedVramMb = 0;
  }

  get available(): number {
    return this.budgetMb - this.usedVramMb;
  }
}

// ── Dependency Graph → Parallel Groups ───────────────────────────────────────

/**
 * Topological sort subtasks into execution groups.
 * Subtasks with no unmet dependencies go into the earliest group.
 */
function buildParallelGroups(subtasks: RoutableSubtask[]): RoutableSubtask[][] {
  const groups: RoutableSubtask[][] = [];
  const resolved = new Set<string>();
  const remaining = [...subtasks];

  while (remaining.length > 0) {
    const group: RoutableSubtask[] = [];

    for (let i = remaining.length - 1; i >= 0; i--) {
      const task = remaining[i];
      const depsMetOrEmpty = task.dependencies.length === 0
        || task.dependencies.every((dep) => resolved.has(dep));

      if (depsMetOrEmpty) {
        group.push(task);
        remaining.splice(i, 1);
      }
    }

    if (group.length === 0) {
      // Circular dependency — force remaining into last group
      console.warn('[SmartRouter] Circular dependency detected, forcing remaining subtasks');
      groups.push(remaining.splice(0));
      break;
    }

    // Sort group by priority (lower = first)
    group.sort((a, b) => (a as any).priority - (b as any).priority);
    groups.push(group);
    group.forEach((t) => resolved.add(t.id));
  }

  return groups;
}

// ── Model Selection ──────────────────────────────────────────────────────────

/**
 * Select the best model for a subtask:
 * 1. Filter by complexity capability
 * 2. Prefer local if VRAM available (cost = 0)
 * 3. Fall back to cheapest cloud
 * 4. Respect VRAM budget for parallel local models
 */
function selectModel(
  subtask: RoutableSubtask,
  vramTracker: VramBudgetTracker,
  preferLocal: boolean = true,
): RouteDecision {
  const complexity: TaskComplexity = subtask.estimatedComplexity ?? 'simple';

  // Get all capable models sorted by cost
  const candidates = modelRegistry
    .filter((m) => m.available && complexityMeetsRequirement(m.maxComplexity, complexity))
    .sort((a, b) => {
      if (preferLocal) {
        const aLocal = a.vramMb > 0 ? 0 : 1;
        const bLocal = b.vramMb > 0 ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
      }
      if (a.costPerCall !== b.costPerCall) return a.costPerCall - b.costPerCall;
      return a.avgLatencyMs - b.avgLatencyMs;
    });

  // Try to fit a local model first
  for (const model of candidates) {
    if (model.vramMb > 0) {
      // Local model — check VRAM budget
      if (vramTracker.canFit(model)) {
        vramTracker.allocate(model);
        return {
          subtaskId: subtask.id,
          model,
          reason: `Local ${model.name} fits VRAM budget (${model.vramMb}MB, ${vramTracker.available}MB remaining)`,
        };
      }
      // Doesn't fit — skip to next candidate
      continue;
    } else {
      // Cloud model — always available
      return {
        subtaskId: subtask.id,
        model,
        reason: `Cloud ${model.name} — local VRAM insufficient (${vramTracker.available}MB free)`,
      };
    }
  }

  // Absolute fallback — cheapest cloud model
  const fallback = modelRegistry.find((m) => m.vramMb === 0 && m.available);
  if (fallback) {
    return {
      subtaskId: subtask.id,
      model: fallback,
      reason: `Fallback to ${fallback.name} — no suitable model found`,
    };
  }

  throw new Error(`[SmartRouter] No available model for subtask ${subtask.id} (complexity: ${complexity})`);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RoutingResult {
  groups: Array<{
    groupIndex: number;
    subtasks: Array<{
      subtask: RoutableSubtask;
      model: ModelCapability;
      reason: string;
    }>;
    totalVramMb: number;
    estimatedLatencyMs: number;
  }>;
  summary: {
    totalSubtasks: number;
    totalGroups: number;
    localAssignments: number;
    cloudAssignments: number;
    estimatedCost: number;
    estimatedTotalLatencyMs: number;
  };
}

/**
 * Route subtasks to optimal models and organize into parallel execution groups.
 *
 * @param subtasks - Subtasks from diagnosticPlan
 * @param preferLocal - Prefer free local models over cloud (default: true)
 * @returns RoutingResult with groups, assignments, and cost estimate
 */
export function routeSubtasks(
  subtasks: RoutableSubtask[],
  preferLocal: boolean = true,
): RoutingResult {
  // Step 1: Build parallel groups from dependency graph
  const parallelGroups = buildParallelGroups(subtasks);

  let totalLocalAssignments = 0;
  let totalCloudAssignments = 0;
  let totalCost = 0;
  let totalLatency = 0;

  const groups = parallelGroups.map((group, groupIndex) => {
    // Each group gets fresh VRAM budget (previous group's models unloaded)
    const vramTracker = new VramBudgetTracker();
    let groupMaxLatency = 0;
    let groupVram = 0;

    const assignments = group.map((subtask) => {
      const decision = selectModel(subtask, vramTracker, preferLocal);

      // Annotate subtask with routing info
      subtask.assignedModel = decision.model.modelId;
      subtask.parallelGroup = groupIndex;
      subtask.estimatedVramMb = decision.model.vramMb;

      // Track stats
      if (decision.model.vramMb > 0) {
        totalLocalAssignments++;
      } else {
        totalCloudAssignments++;
      }
      totalCost += decision.model.costPerCall;
      groupMaxLatency = Math.max(groupMaxLatency, decision.model.avgLatencyMs);
      groupVram += decision.model.vramMb;

      return {
        subtask,
        model: decision.model,
        reason: decision.reason,
      };
    });

    totalLatency += groupMaxLatency; // Groups are sequential

    return {
      groupIndex,
      subtasks: assignments,
      totalVramMb: groupVram,
      estimatedLatencyMs: groupMaxLatency,
    };
  });

  return {
    groups,
    summary: {
      totalSubtasks: subtasks.length,
      totalGroups: groups.length,
      localAssignments: totalLocalAssignments,
      cloudAssignments: totalCloudAssignments,
      estimatedCost: totalCost,
      estimatedTotalLatencyMs: totalLatency,
    },
  };
}

/**
 * Pretty-print routing result for logging/diagnostics.
 */
export function formatRoutingResult(result: RoutingResult): string {
  const lines: string[] = [
    `\n═══ Smart Router — ${result.summary.totalSubtasks} subtasks → ${result.summary.totalGroups} groups ═══`,
    `   Local: ${result.summary.localAssignments} | Cloud: ${result.summary.cloudAssignments} | Est. cost: $${(result.summary.estimatedCost * 0.01).toFixed(2)}`,
    `   Est. total time: ${(result.summary.estimatedTotalLatencyMs / 1000).toFixed(1)}s`,
    '',
  ];

  for (const group of result.groups) {
    lines.push(`── Group ${group.groupIndex} (parallel, ~${(group.estimatedLatencyMs / 1000).toFixed(1)}s, ${group.totalVramMb}MB VRAM) ──`);
    for (const { subtask, model, reason } of group.subtasks) {
      const tag = model.vramMb > 0 ? '🖥️ LOCAL' : '☁️ CLOUD';
      lines.push(`   ${tag} [${subtask.id}] → ${model.name} (${(subtask as any).estimatedComplexity ?? '?'}) — ${reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
