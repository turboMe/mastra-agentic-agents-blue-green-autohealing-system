import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { DELIBERATION_AGENT_MASTRA_AGENT_ID } from '../config/agent-ids.js';
import { resolveModelId, agentModels, infrastructure } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { runDeliberationWorkerTool } from '../tools/deliberation/run-deliberation-worker.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { writeDebateArtifactTool } from '../tools/deliberation/write-debate-artifact.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { currentTimeTool } from '../tools/system/current-time.js';

export const deliberationAgent = new Agent({
  id: DELIBERATION_AGENT_MASTRA_AGENT_ID,
  name: 'Deliberation Agent (Design Council)',
  instructions: await loadPrompt('deliberation/base'),
  model: resolveModelId(agentModels.deliberationAgent),
  maxRetries: 3,
  defaultOptions: { maxSteps: 40 },
  defaultGenerateOptionsLegacy: { maxSteps: 40 },
  defaultStreamOptionsLegacy: { maxSteps: 40 },
  defaultNetworkOptions: { maxSteps: 40 },
  memory: new Memory({
    options: {
      lastMessages: 20,
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread',
        temporalMarkers: true,
        observation: { threadTitle: true },
      },
      workingMemory: {
        enabled: true,
        template: `# Deliberation Agent Working Memory

## Active Debate
- **Current task:**
- **Debate depth:**
- **Workers selected:**
- **Phase:**

## Past Debate Patterns
- **Effective combinations:**
- **Known failure patterns:**
- **User preferences:**
`,
      },
      generateTitle: {
        model: resolveModelId('gemma4-e4b'),
        instructions:
          'Generate a concise thread title in the user language. Return only the title text, max 60 characters.',
      },
    },
  }),
  tools: {
    runDeliberationWorkerTool,
    writeDebateArtifactTool,
    memoryRecallTool,
    memoryWriteTool,
    currentTimeTool,
    requestApprovalTool,
  },
});
