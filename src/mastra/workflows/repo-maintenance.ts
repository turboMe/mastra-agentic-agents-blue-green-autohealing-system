import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getDb } from '../lib/mongo.js';
import { getErrorCollector } from '../services/error-collector.js';

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

// ── Step 1a: Diagnose and Plan ───────────────────────────────────────────────

const diagnoseAndPlan = createStep({
  id: 'diagnose-and-plan',
  description: 'Faza diagnostyczna: szerokie badanie błędu, analiza wpływu, ustrukturyzowany plan naprawy z subtaskami.',
  inputSchema: codingTaskSchema,
  outputSchema: codingOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codingAgent');
    if (!agent) throw new Error('codingAgent not found');

    const taskId = inputData.taskId || randomUUID();

    // Ładujemy diagnostyczny prompt dynamicznie — NIE jest częścią base.md agenta
    let diagnosticInstructions: string;
    try {
      const { loadPrompt } = await import('../lib/prompt-loader.js');
      diagnosticInstructions = await loadPrompt('coding/diagnose');
    } catch {
      // Fallback jeśli plik promptu nie istnieje
      diagnosticInstructions = `Przeprowadź szeroki skan kontekstu. Zbadaj plik błędu, importy, eksporty, zależności. Znajdź pliki powiązane i testy. Stwórz plan naprawy z subtaskami. NIE edytuj plików.`;
    }

    const prompt = [
      diagnosticInstructions,
      ``,
      `## Zadanie do diagnozy`,
      ``,
      inputData.userRequest,
      ``,
      `## Identyfikator zadania: ${taskId}`,
      ``,
      `Na samym początku użyj \`coding.create_artifact\` aby zainicjować artifact z ID: ${taskId}.`,
      `Po zakończeniu diagnostyki zaktualizuj artifact (\`coding.update_artifact\`) z pełnym polem \`diagnosticPlan\` i ustaw status na \`planning\`.`,
    ].join('\n');

    await agent.generate(prompt);

    // ── Post-diagnosis: Smart Router assigns models & parallel groups ──
    try {
      const { routeSubtasks, formatRoutingResult } = await import('../services/smart-router.js');
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

      if (artifact?.diagnosticPlan?.subtasks?.length) {
        const routingResult = routeSubtasks(artifact.diagnosticPlan.subtasks);
        console.log(formatRoutingResult(routingResult));

        // Write routed subtasks back to artifact
        await db.collection('code_task_artifacts').updateOne(
          { taskId },
          {
            $set: {
              'diagnosticPlan.subtasks': artifact.diagnosticPlan.subtasks, // mutated in-place by router
              'diagnosticPlan.routingSummary': routingResult.summary,
              updatedAt: new Date().toISOString(),
            },
          },
        );
      }
    } catch (routeErr) {
      // Non-fatal — execute-patch can still work without routing
      console.warn('[diagnose-and-plan] Smart Router failed, subtasks will run sequentially:', (routeErr as Error).message);
    }

    return {
      taskId,
      status: 'planning',
      iteration: 1,
    };
  },
});

// ── Step 1b: Execute Patch ───────────────────────────────────────────────────

const executePatch = createStep({
  id: 'execute-patch',
  description: 'Realizacja planu naprawy: tworzenie worktree, edycja plików zgodnie z diagnosticPlan, generacja diff.',
  inputSchema: codingOutputSchema,
  outputSchema: codingOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codingAgent');
    if (!agent) throw new Error('codingAgent not found');

    const taskId = inputData.taskId;

    // Pobierz plan diagnostyczny z artifact
    const db = await getDb();
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

    let planContext = '';
    if (artifact?.diagnosticPlan) {
      const dp = artifact.diagnosticPlan as any;
      const subtaskList = (dp.subtasks || [])
        .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((s: any) => `  - [${s.id}] (${s.type}, priorytet ${s.priority}): ${s.description} → pliki: ${(s.targetFiles || []).join(', ')}`)
        .join('\n');

      planContext = [
        `## Plan diagnostyczny (przygotowany wcześniej)`,
        ``,
        `**Root cause:** ${dp.rootCause}`,
        `**Hipoteza:** ${dp.hypothesis}`,
        `**Ryzyko:** ${dp.riskLevel} — ${dp.riskJustification}`,
        ``,
        `**Analiza wpływu:**`,
        `- Plik błędu: ${dp.impactAnalysis?.errorFile || 'N/A'}`,
        `- Pliki bezpośrednie: ${(dp.impactAnalysis?.directFiles || []).join(', ') || 'brak'}`,
        `- Pliki zależne: ${(dp.impactAnalysis?.dependentFiles || []).join(', ') || 'brak'}`,
        `- Testy: ${(dp.impactAnalysis?.testFiles || []).join(', ') || 'brak'}`,
        ``,
        `**Subtaski (realizuj w kolejności priorytetów):**`,
        subtaskList || '  (brak subtasków)',
        ``,
        `**Weryfikacja po naprawie:**`,
        `- Komendy: ${(dp.verificationPlan?.commands || []).join(', ')}`,
        `- Oczekiwany wynik: ${dp.verificationPlan?.expectedOutcome || 'TSC clean'}`,
      ].join('\n');
    } else {
      planContext = `Brak planu diagnostycznego — działaj standardowo: zdiagnozuj i napraw.`;
    }

    const prompt = [
      `Realizuj plan naprawy. Masz gotową diagnozę — skup się na implementacji.`,
      ``,
      planContext,
      ``,
      `## Identyfikator zadania: ${taskId}`,
      ``,
      `Użyj pełnego cyklu Staging Worktree (\`coding.init_worktree\`).`,
      `Po zapisaniu wszystkich plików w worktree, KONIECZNIE:`,
      `1. Uruchom w worktree komendę: git diff HEAD (aby wygenerować diff zmian).`,
      `2. Zaktualizuj artefakt (\`coding.update_artifact\`) ustawiając pole diffSummary na wynik tego diffa.`,
      `3. Ustaw status artefaktu na waiting_approval.`,
      `UWAGA: nie wywołuj narzędzia apply_patch samodzielnie! Oczekujesz na codeReviewAgent.`,
    ].join('\n');

    await agent.generate(prompt);

    // Backup: jeśli agent nie wypełnił diffSummary, spróbujmy to zrobić automatycznie
    const updatedArtifact = await db.collection('code_task_artifacts').findOne({ taskId });
    if (updatedArtifact?.worktreePath && (!updatedArtifact.diffSummary || updatedArtifact.diffSummary.trim() === '')) {
      try {
        const { execSync } = await import('child_process');
        const diff = execSync('git diff HEAD', {
          cwd: updatedArtifact.worktreePath,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        if (diff) {
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
      taskId,
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

// ── Step 4: Deploy & Verify (dry-run build + health check) ───────────────────

const deployOutputSchema = z.object({
  taskId: z.string(),
  deployStatus: z.enum(['deployed_and_verified', 'deploy_failed', 'skipped']),
  version: z.string().optional(),
  message: z.string(),
});

const deployAndVerify = createStep({
  id: 'deploy-and-verify',
  description: 'Buduje i weryfikuje nowy kod w staging (dry-run). Nie zamienia live.',
  inputSchema: z.object({
    taskId: z.string(),
    action: z.enum(['approved_and_merged', 'loop_back', 'blocked', 'max_iterations_reached']),
    message: z.string(),
  }),
  outputSchema: deployOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Input data not found');

    // Tylko jeśli decision-gate zakończył się merge'em
    if (inputData.action !== 'approved_and_merged') {
      return {
        taskId: inputData.taskId,
        deployStatus: 'skipped' as const,
        message: `Deploy pominięty — action: ${inputData.action}`,
      };
    }

    try {
      const { execSync } = await import('child_process');
      const { resolve, dirname } = await import('path');
      const { existsSync } = await import('fs');

      // Mastra uruchamia kod z .mastra/output/ lub src/mastra/public/ —
      // musimy znaleźć root projektu szukając deploy.config.json w górę drzewa.
      let projectRoot = process.cwd();
      while (projectRoot !== '/') {
        if (existsSync(resolve(projectRoot, 'deploy.config.json'))) break;
        projectRoot = dirname(projectRoot);
      }

      const scriptPath = resolve(projectRoot, 'scripts/deploy-blue-green.sh');

      const output = execSync(`bash "${scriptPath}" --dry-run`, {
        encoding: 'utf-8',
        timeout: 180_000,  // 3 minuty max
        cwd: projectRoot,
      });

      // Sprawdź czy output zawiera potwierdzenie sukcesu
      const isHealthy = output.includes('DRY RUN COMPLETE');

      // Wyciągnij wersję z outputu
      const versionMatch = output.match(/Version:\s+(\S+)/);
      const version = versionMatch?.[1] || 'unknown';

      // Jeśli deploy się powiódł i task pochodzi z auto-heal, zamknij ticket
      if (isHealthy && inputData.taskId.startsWith('heal-')) {
        try {
          const collector = getErrorCollector();
          await collector.resolveTicket(inputData.taskId);
          console.log(`[deploy-and-verify] Auto-heal ticket ${inputData.taskId} resolved.`);
        } catch {
          // Nie blokuj deploy jeśli cleanup ticketa nie zadziała
        }
      }

      return {
        taskId: inputData.taskId,
        deployStatus: isHealthy ? 'deployed_and_verified' as const : 'deploy_failed' as const,
        version,
        message: isHealthy
          ? `Staging zbudowany i zweryfikowany (wersja: ${version}). Nowy kod gotowy do wdrożenia.`
          : 'Deploy dry-run nie potwierdził zdrowia staging.',
      };
    } catch (error: any) {
      return {
        taskId: inputData.taskId,
        deployStatus: 'deploy_failed' as const,
        message: `Deploy failed: ${error.message?.slice(0, 500)}`,
      };
    }
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────────

const repoMaintenanceWorkflow = createWorkflow({
  id: 'repo-maintenance-workflow',
  description: 'Self-healing workflow: Diagnose → Patch → Review → Decision Gate → Deploy Verify',
  inputSchema: codingTaskSchema,
  outputSchema: deployOutputSchema,
})
  .then(diagnoseAndPlan)
  .then(executePatch)
  .then(executeReviewAgent)
  .then(decisionGate)
  .then(deployAndVerify);

repoMaintenanceWorkflow.commit();

export { repoMaintenanceWorkflow };
