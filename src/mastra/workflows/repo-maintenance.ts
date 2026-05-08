import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const codingTaskSchema = z.object({
  userRequest: z.string().describe('Instrukcja dla agenta kodującego.'),
  taskId: z.string().optional().describe('Opcjonalne wymuszenie ID taska, jeśli istnieje.'),
});

const codingOutputSchema = z.object({
  taskId: z.string(),
  status: z.string(),
});

const executeCodingAgent = createStep({
  id: 'execute-coding-agent',
  description: 'Wysyła zadanie programistyczne do codingAgent w celu utworzenia worktree i modyfikacji kodu.',
  inputSchema: codingTaskSchema,
  outputSchema: codingOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codingAgent');
    if (!agent) throw new Error('codingAgent not found');

    const prompt = `Rozpocznij realizację zadania: ${inputData.userRequest}
    Użyj pełnego cyklu Staging Worktree.
    Gdy zakończysz testowanie, zaktualizuj artefakt by zasygnalizować gotowość do wdrożenia.
    UWAGA: nie wywołuj narzędzia apply_patch samodzielnie! Oczekujesz na codeReviewAgent.`;

    const response = await agent.generate(prompt);

    // W idealnym scenariuszu agent zwraca taskId w formacie ustrukturyzowanym,
    // na ten moment workflow założy, że zadanie zostało przypisane lub wyekstrahowane z logów.
    return {
      taskId: inputData.taskId || 'generated-task-id',
      status: 'waiting_approval',
    };
  },
});

const executeReviewAgent = createStep({
  id: 'execute-review-agent',
  description: 'Wykonuje przegląd kodu na wygenerowanym worktree za pomocą codeReviewAgent.',
  inputSchema: codingOutputSchema,
  outputSchema: z.object({
    verdict: z.enum(['approve', 'needs_changes', 'block']),
    comments: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('code-review-agent');
    if (!agent) throw new Error('codeReviewAgent not found');

    const prompt = `Zadanie ${inputData.taskId} oczekuje na twoje Code Review. 
    Pobierz artefakt tego zadania przy pomocy getCodeTaskArtifactTool, a następnie przeanalizuj diff.
    Na końcu użyj submitReviewTool i prześlij verdict (approve/needs_changes) wraz z uzasadnieniem.`;

    const response = await agent.generate(prompt);

    // Aby zyskać pełen rezultat, workflow odpytałby tu bazę Mongo o najnowszy status.
    // Zakładamy, że reviewer użył submitReviewTool.
    return {
      verdict: 'approve' as const, // TODO: Fetch real verdict from Mongo
      comments: 'text' in response ? response.text : 'No text response',
    };
  },
});

const repoMaintenanceWorkflow = createWorkflow({
  id: 'repo-maintenance-workflow',
  description: 'Workflow zarządzający cyklem życia zadania: Coding -> Review -> Merge',
  inputSchema: codingTaskSchema,
  outputSchema: z.object({
    verdict: z.enum(['approve', 'needs_changes', 'block']),
    comments: z.string(),
  }),
})
  .then(executeCodingAgent)
  .then(executeReviewAgent);

repoMaintenanceWorkflow.commit();

export { repoMaintenanceWorkflow };
