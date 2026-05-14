import { compactHarnessOutput } from './harness-output-compactor.js';
import type { ToolEnvelopeMetadata } from './harness-tool-envelope.js';

type AutomationCompactionMetadata = ToolEnvelopeMetadata & {
  agentId?: string;
  toolId: string;
};

type CompactAutomationResultOptions = {
  previewBytes?: number;
  maxGenericArrayItems?: number;
};

type CompactedArraySummary = {
  path: string;
  originalCount: number;
  returnedCount: number;
};

type SummaryContext = {
  arrays: CompactedArraySummary[];
  maxGenericArrayItems: number;
};

const DEFAULT_STRUCTURED_PREVIEW_BYTES = 4000;
const DEFAULT_GENERIC_ARRAY_ITEMS = 8;
const MAX_STRING_CHARS = 1200;

/**
 * Store the full automation tool result as a harness artifact when it is too
 * large, then return a compact structure to the model. Scalars and contract
 * fields stay intact; high-volume arrays and nested diagnostic data are
 * shortened with counts recorded under `outputCompaction`.
 */
export async function compactAutomationResultForModel<T>(
  output: T,
  metadata: AutomationCompactionMetadata,
  options: CompactAutomationResultOptions = {},
): Promise<T> {
  const fullText = stringify(output);
  const compaction = await compactHarnessOutput({
    text: fullText,
    kind: 'tool_output',
    taskId: metadata.taskId,
    subtaskId: metadata.subtaskId,
    agentId: metadata.agentId ?? 'automationArchitect',
    threadId: metadata.threadId,
    runId: metadata.runId,
    turnId: metadata.turnId,
    toolId: metadata.toolId,
    previewBytes: options.previewBytes ?? DEFAULT_STRUCTURED_PREVIEW_BYTES,
    metadata: { scope: 'automation_model_output' },
  });

  if (!compaction.truncated || !output || typeof output !== 'object') {
    return output;
  }

  const ctx: SummaryContext = {
    arrays: [],
    maxGenericArrayItems: options.maxGenericArrayItems ?? DEFAULT_GENERIC_ARRAY_ITEMS,
  };
  const summarized = summarizeValue(output, '$', ctx);

  if (!summarized || typeof summarized !== 'object' || Array.isArray(summarized)) {
    return output;
  }

  return {
    ...(summarized as Record<string, unknown>),
    outputArtifactId: compaction.fullTextArtifactId,
    outputTruncated: true,
    originalBytes: compaction.originalBytes,
    previewBytes: compaction.previewBytes,
    outputCompaction: {
      artifactId: compaction.fullTextArtifactId,
      originalBytes: compaction.originalBytes,
      previewBytes: compaction.previewBytes,
      compactedArrays: ctx.arrays,
    },
  } as T;
}

function summarizeValue(value: unknown, path: string, ctx: SummaryContext, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value, MAX_STRING_CHARS);
  if (typeof value !== 'object') return value;
  if (depth > 5) return '[Max depth: full data in outputArtifactId]';

  if (Array.isArray(value)) {
    const limit = arrayLimitForPath(path, ctx.maxGenericArrayItems);
    const returned = value.slice(0, limit).map((entry, index) =>
      summarizeValue(entry, `${path}[${index}]`, ctx, depth + 1),
    );
    if (value.length > returned.length) {
      ctx.arrays.push({
        path,
        originalCount: value.length,
        returnedCount: returned.length,
      });
    }
    return returned;
  }

  if (isWorkflowLike(value)) {
    return summarizeWorkflow(value as Record<string, unknown>);
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = summarizeValue(entry, `${path}.${key}`, ctx, depth + 1);
  }
  return out;
}

function arrayLimitForPath(path: string, fallback: number): number {
  if (/\.(errors|securityIssues|missingCredentials|missingConfig|findings|warnings|changes|remainingIssues|recoveryStrategies)$/.test(path)) {
    return 12;
  }
  if (/\.steps$/.test(path)) return 20;
  if (/\.testPlan$/.test(path)) return 20;
  return fallback;
}

function isWorkflowLike(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.nodes) && Boolean(record.connections);
}

function summarizeWorkflow(workflow: Record<string, unknown>): Record<string, unknown> {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const connections = workflow.connections && typeof workflow.connections === 'object'
    ? Object.keys(workflow.connections as Record<string, unknown>).length
    : 0;

  return {
    name: workflow.name,
    id: workflow.id,
    active: workflow.active,
    nodeCount: nodes.length,
    connectionCount: connections,
    nodes: nodes.slice(0, 12).map((node) => {
      if (!node || typeof node !== 'object') return node;
      const record = node as Record<string, unknown>;
      return {
        id: record.id,
        name: record.name,
        type: record.type,
        typeVersion: record.typeVersion,
      };
    }),
    truncated: nodes.length > 12,
    message: 'Full workflow JSON is stored in outputArtifactId.',
  };
}

function stringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
