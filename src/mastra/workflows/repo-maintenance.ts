import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getDb } from '../lib/mongo.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

const codingTaskSchema = z.object({
  userRequest: z.string().describe('Instrukcja dla agenta kodującego.'),
  taskId: z.string().optional().describe('Opcjonalne wymuszenie ID taska, jeśli istnieje.'),
});

const codingOutputSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  iteration: z.number(),
});

const reviewOutputSchema = z.object({
  taskId: z.string(),
  verdict: z.enum(['approve', 'needs_changes', 'block']),
  comments: z.string(),
  iteration: z.number(),
});

const MAX_REVIEW_ITERATIONS = 3;

// ── Step 1: Coding Agent ─────────────────────────────────────────────────────

const executeCodingAgent = createStep({
  id: 'execute-coding-agent',
  description: 'Wysyła zadanie programistyczne do codingAgent w celu utworzenia worktree i modyfikacji kodu.',
  inputSchema: codingTaskSchema,
  outputSchema: codingOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codingAgent');
    if (!agent) throw new Error('codingAgent not found');

    const taskId = inputData.taskId || randomUUID();

    const prompt = `Rozpocznij realizację zadania: ${inputData.userRequest}
    Identyfikator zadania: ${taskId}
    Na samym początku użyj coding.create_artifact aby zainicjować wpis w bazie używając dokładnie ID: ${taskId}.
    Użyj pełnego cyklu Staging Worktree (coding.init_worktree).
    Po zapisaniu wszystkich plików w worktree, KONIECZNIE:
    1. Uruchom w worktree komendę: git diff HEAD (aby wygenerować diff zmian).
    2. Zaktualizuj artefakt (coding.update_artifact) ustawiając pole diffSummary na wynik tego diffa.
    3. Ustaw status artefaktu na waiting_approval.
    UWAGA: nie wywołuj narzędzia apply_patch samodzielnie! Oczekujesz na codeReviewAgent.`;

    await agent.generate(prompt);

    // Backup: jeśli agent nie wypełnił diffSummary, spróbujmy to zrobić automatycznie
    const db = await getDb();
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
    if (artifact?.worktreePath && (!artifact.diffSummary || artifact.diffSummary.trim() === '')) {
      try {
        const { execSync } = await import('child_process');
        const diff = execSync('git diff HEAD', {
          cwd: artifact.worktreePath,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        if (diff) {
          // Ograniczamy diff do 4000 znaków żeby nie przeciążyć LLM
          const truncatedDiff = diff.length > 4000 ? diff.slice(0, 4000) + '\n... (skrócono)' : diff;
          await db.collection('code_task_artifacts').updateOne(
            { taskId },
            { $set: { diffSummary: truncatedDiff, updatedAt: new Date().toISOString() } }
          );
        }
      } catch {
        // Ignoruj błąd — diff opcjonalny
      }
    }

    return {
      taskId: taskId,
      status: 'waiting_approval',
      iteration: 1,
    };
  },
});

// ── Step 2: Code Review Agent ────────────────────────────────────────────────

const executeReviewAgent = createStep({
  id: 'execute-review-agent',
  description: 'Wykonuje przegląd kodu na wygenerowanym worktree za pomocą codeReviewAgent.',
  inputSchema: codingOutputSchema,
  outputSchema: reviewOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codeReviewAgent');
    if (!agent) throw new Error('codeReviewAgent not found');

    // Ładujemy artefakt z Mongo PRZED wywołaniem agenta, żeby dostarczyć diff w prompcie
    const db = await getDb();
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId: inputData.taskId });

    const diffContent = artifact?.diffSummary || '(brak diffa — pliki mogły zostać dodane jako nowe)';
    const filesChanged = Array.isArray(artifact?.filesChanged)
      ? artifact.filesChanged.map((f: any) => `${f.path}: ${f.summary}`).join('\n')
      : '(brak informacji o zmienionych plikach)';

    const prompt = `Zadanie ${inputData.taskId} oczekuje na twoje Code Review (iteracja: ${inputData.iteration}/${MAX_REVIEW_ITERATIONS}).

    Zmienione pliki:
    ${filesChanged}

    Diff zmian:
    \`\`\`
    ${diffContent}
    \`\`\`

    Przeanalizuj powyższy diff pod kątem:
    - Poprawności logicznej i składniowej
    - Bezpieczeństwa (brak hardkodowanych sekretów, niebezpiecznych operacji)
    - Zgodności ze stylem projektu
    
    Na końcu użyj submitReviewTool i prześlij verdict (approve/needs_changes) wraz z uzasadnieniem.
    Jeśli diff wygląda poprawnie i spełnia wymagania zadania, daj approve.`;

    const response = await agent.generate(prompt);

    // Odczytujemy faktyczny werdykt z MongoDB (tam submitReviewTool go zapisał)
    const updatedArtifact = await db.collection('code_task_artifacts').findOne({ taskId: inputData.taskId });

    const finalVerdict = updatedArtifact?.reviewVerdict || 'needs_changes';

    return {
      taskId: inputData.taskId,
      verdict: finalVerdict as 'approve' | 'needs_changes' | 'block',
      comments: 'text' in response ? (response.text as string) : 'No text response',
      iteration: inputData.iteration,
    };
  },
});

// ── Step 3: Decision Gate (Suspend on Approve / Loop on Needs Changes) ───────

const decisionGate = createStep({
  id: 'decision-gate',
  description: 'Bramka decyzyjna: Jeśli approve → suspend i czekaj na zatwierdzenie. Jeśli needs_changes → przygotuj dane do kolejnej iteracji.',
  inputSchema: reviewOutputSchema,
  outputSchema: z.object({
    taskId: z.string(),
    action: z.enum(['approved_and_merged', 'loop_back', 'blocked', 'max_iterations_reached']),
    message: z.string(),
  }),
  resumeSchema: z.object({
    confirmMerge: z.boolean().describe('Czy zatwierdzasz scalanie zmian do repozytorium live?'),
  }),
  suspendSchema: z.object({
    taskId: z.string(),
    verdict: z.string(),
    comments: z.string(),
    message: z.string(),
  }),
  execute: async ({ inputData, resumeData, suspend, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const { taskId, verdict, comments, iteration } = inputData;

    // ── APPROVE → Suspend (Human-in-the-loop) ──
    if (verdict === 'approve') {
      // Jeśli nie mamy jeszcze odpowiedzi użytkownika, zawieszamy workflow
      if (!resumeData) {
        return await suspend({
          taskId,
          verdict,
          comments,
          message: `✅ Code Review APPROVED (iteracja ${iteration}). Oczekuję na zatwierdzenie scalania (confirmMerge: true) przez człowieka.`,
        });
      }

      // Użytkownik zatwierdzil → wywołujemy apply_patch
      if (resumeData.confirmMerge) {
        const agent = mastra?.getAgent('codingAgent');
        if (!agent) throw new Error('codingAgent not found for merge');

        await agent.generate(`Użyj narzędzia coding.apply_patch z taskId="${taskId}" aby scalić zatwierdzone zmiany do głównego repozytorium. Następnie użyj coding.remove_worktree z taskId="${taskId}" aby posprzątać zasoby worktree.`);

        return {
          taskId,
          action: 'approved_and_merged' as const,
          message: `Zmiany zadania ${taskId} zostały scalone do repozytorium live i worktree usunięty.`,
        };
      } else {
        // Użytkownik odrzucił merge — traktujemy jak block
        return {
          taskId,
          action: 'blocked' as const,
          message: `Użytkownik odrzucił merge dla ${taskId}.`,
        };
      }
    }

    // ── NEEDS_CHANGES → Loop back (jeśli nie przekroczono limitu iteracji) ──
    if (verdict === 'needs_changes') {
      if (iteration >= MAX_REVIEW_ITERATIONS) {
        return {
          taskId,
          action: 'max_iterations_reached' as const,
          message: `Osiągnięto limit ${MAX_REVIEW_ITERATIONS} iteracji. Interwencja ludzka wymagana dla zadania ${taskId}. Ostatni komentarz: ${comments}`,
        };
      }

      // Oddeleguj poprawki do codingAgenta
      const agent = mastra?.getAgent('codingAgent');
      if (!agent) throw new Error('codingAgent not found for rework');

      await agent.generate(`Zadanie ${taskId} wymaga poprawek. Komentarz codeReviewAgent (iteracja ${iteration}):
      ${comments}
      Popraw kod w worktree zgodnie z uwagami. Gdy skończysz poprawki, zaktualizuj artefakt (coding.update_artifact) i ustaw status na waiting_approval.`);

      // Teraz ponownie uruchamiamy review
      const reviewAgent = mastra?.getAgent('codeReviewAgent');
      if (!reviewAgent) throw new Error('codeReviewAgent not found for re-review');

      const nextIteration = iteration + 1;

      await reviewAgent.generate(`Zadanie ${taskId} zostało poprawione (iteracja ${nextIteration}/${MAX_REVIEW_ITERATIONS}).
      Pobierz artefakt i przeprowadź ponowne Code Review.
      Użyj submitReviewTool aby zaktualizować werdykt.`);

      // Sprawdzamy ponownie verdict z Mongo
      const db = await getDb();
      const updatedArtifact = await db.collection('code_task_artifacts').findOne({ taskId });
      const newVerdict = updatedArtifact?.reviewVerdict || 'needs_changes';

      if (newVerdict === 'approve') {
        // Po poprawkach reviewer zaakceptował — zawieszamy na zatwierdzenie
        if (!resumeData) {
          return await suspend({
            taskId,
            verdict: 'approve',
            comments: `Po ${nextIteration} iteracjach reviewer zaakceptował zmiany.`,
            message: `✅ Code Review APPROVED po iteracji ${nextIteration}. Oczekuję na zatwierdzenie scalania.`,
          });
        }

        if (resumeData.confirmMerge) {
          const mergeAgent = mastra?.getAgent('codingAgent');
          if (mergeAgent) {
            await mergeAgent.generate(`Użyj narzędzia coding.apply_patch z taskId="${taskId}" i następnie coding.remove_worktree z taskId="${taskId}".`);
          }
          return {
            taskId,
            action: 'approved_and_merged' as const,
            message: `Zmiany po iteracji ${nextIteration} scalone do live.`,
          };
        }
      }

      if (nextIteration >= MAX_REVIEW_ITERATIONS) {
        return {
          taskId,
          action: 'max_iterations_reached' as const,
          message: `Limit ${MAX_REVIEW_ITERATIONS} iteracji osiągnięty. Werdykt po ostatnim review: ${newVerdict}. Wymaga interwencji człowieka.`,
        };
      }

      return {
        taskId,
        action: 'loop_back' as const,
        message: `Iteracja ${nextIteration}: reviewer nadal widzi problemy. Kolejna runda naprawcza wymagana.`,
      };
    }

    // ── BLOCK → natychmiastowe zatrzymanie ──
    return {
      taskId,
      action: 'blocked' as const,
      message: `Reviewer zablokował zadanie ${taskId}. Komentarz: ${comments}`,
    };
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────────

const repoMaintenanceWorkflow = createWorkflow({
  id: 'repo-maintenance-workflow',
  description: 'Self-healing workflow: Coding → Review → Decision Gate (suspend/loop/block)',
  inputSchema: codingTaskSchema,
  outputSchema: z.object({
    taskId: z.string(),
    action: z.enum(['approved_and_merged', 'loop_back', 'blocked', 'max_iterations_reached']),
    message: z.string(),
  }),
})
  .then(executeCodingAgent)
  .then(executeReviewAgent)
  .then(decisionGate);

repoMaintenanceWorkflow.commit();

export { repoMaintenanceWorkflow };
