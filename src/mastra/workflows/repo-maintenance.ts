import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getDb } from '../lib/mongo.js';
import { getErrorCollector } from '../services/error-collector.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { anthropicCacheOptions } from '../lib/anthropic-cache.js';

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
      `Na samym początku użyj \`coding_create_artifact\` aby zainicjować artifact z ID: ${taskId}.`,
      `Po zakończeniu diagnostyki zaktualizuj artifact (\`coding_update_artifact\`) z pełnym polem \`diagnosticPlan\` i ustaw status na \`planning\`.`,
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
  description: 'Realizacja planu naprawy: routing → parallel dispatch subtasków → aggregation → validation. Fallback na single-agent jeśli brak routingu.',
  inputSchema: codingOutputSchema,
  outputSchema: codingOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codingAgent');
    if (!agent) throw new Error('codingAgent not found');

    const taskId = inputData.taskId;
    const db = await getDb();
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

    // ══════════════════════════════════════════════════════════════════════════
    // PATH A: Parallel Dispatch (Etap 8) — subtaski z routingSummary
    // ══════════════════════════════════════════════════════════════════════════
    if (artifact?.diagnosticPlan?.subtasks?.length && artifact.diagnosticPlan.routingSummary) {
      try {
        const { routeSubtasks, formatRoutingResult } = await import('../services/smart-router.js');
        const { dispatchSubtasks, formatDispatchResult } = await import('../services/parallel-dispatch.js');

        // 1. Rebuild routing result from stored subtasks
        const routingResult = routeSubtasks(artifact.diagnosticPlan.subtasks);
        console.log(formatRoutingResult(routingResult));

        // 2. Init worktree
        await agent.generate(
          `Użyj coding_init_worktree z taskId="${taskId}" aby przygotować staging worktree. ` +
          `Odpowiedz krótko kiedy gotowe.`,
        );

        // 3. PARALLEL DISPATCH — heart of Etap 8
        const dispatchResult = await dispatchSubtasks(taskId, routingResult, mastra!);
        console.log(formatDispatchResult(dispatchResult));

        // 4. Post-dispatch: store results in artifact
        await db.collection('code_task_artifacts').updateOne(
          { taskId },
          {
            $set: {
              dispatchResult: {
                groups: dispatchResult.groups.map((g) => ({
                  groupIndex: g.groupIndex,
                  subtasks: g.subtaskResults.map((sr) => ({
                    subtaskId: sr.subtaskId,
                    assignedModel: sr.assignedModel,
                    actualModel: sr.actualModel,
                    status: sr.status,
                    durationMs: sr.durationMs,
                    filesChanged: sr.filesChanged.map((f) => f.path),
                    errors: sr.errors,
                    qualityAttempt: sr.qualityCheck?.attempt,
                  })),
                  durationMs: g.durationMs,
                })),
                summary: {
                  totalSubtasks: dispatchResult.aggregated.totalSubtasks,
                  succeeded: dispatchResult.aggregated.succeeded,
                  failed: dispatchResult.aggregated.failed,
                  skipped: dispatchResult.aggregated.skipped,
                  needsHuman: dispatchResult.aggregated.needsHuman,
                  conflictingFiles: dispatchResult.aggregated.conflictingFiles,
                  totalDurationMs: dispatchResult.aggregated.totalDurationMs,
                  overallStatus: dispatchResult.overallStatus,
                },
              },
              updatedAt: new Date().toISOString(),
            },
          },
        );

        // 5. Post-dispatch verification: generate diff & run tsc
        const updatedArtifact = await db.collection('code_task_artifacts').findOne({ taskId });
        if (updatedArtifact?.worktreePath) {
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
                { $set: { diffSummary: truncatedDiff, status: 'waiting_approval', updatedAt: new Date().toISOString() } },
              );
            }
          } catch { /* diff optional */ }
        }

        // 6. If needs_human subtasks exist, note in artifact
        if (dispatchResult.aggregated.needsHuman > 0) {
          console.warn(
            `[execute-patch] ${dispatchResult.aggregated.needsHuman} subtask(s) need human intervention`,
          );
        }

        return {
          taskId,
          status: 'waiting_approval',
          iteration: inputData.iteration ?? 1,
        };
      } catch (dispatchErr) {
        console.error('[execute-patch] Parallel dispatch failed, falling back to single-agent:', (dispatchErr as Error).message);
        // Fall through to Path B
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PATH B: Legacy Single-Agent Mode (fallback)
    // ══════════════════════════════════════════════════════════════════════════
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
      `Użyj pełnego cyklu Staging Worktree (\`coding_init_worktree\`).`,
      `Po zapisaniu wszystkich plików w worktree, KONIECZNIE:`,
      `1. Uruchom w worktree komendę: git diff HEAD (aby wygenerować diff zmian).`,
      `2. Zaktualizuj artefakt (\`coding_update_artifact\`) ustawiając pole diffSummary na wynik tego diffa.`,
      `3. Ustaw status artefaktu na waiting_approval.`,
      `UWAGA: nie wywołuj narzędzia apply_patch samodzielnie! Oczekujesz na codeReviewAgent.`,
    ].join('\n');

    await agent.generate(prompt);

    // Backup: auto-generate diff if agent didn't
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

    const response = await agent.generate(prompt, anthropicCacheOptions());

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

    // ── APPROVE → Push PR or Local Merge ──
    if (verdict === 'approve') {
      const prMode = process.env.GITHUB_PR_MODE === 'true';

      // ═══════════════════════════════════════════════════════════
      // PATH A: GitHub PR Mode (Etap 9)
      // ═══════════════════════════════════════════════════════════
      if (prMode) {
        if (!resumeData) {
          // 1. Push branch + Create PR
          try {
            const { pushBranch, createPR, waitForCI } = await import('../services/github.js');
            const { buildPRBody, buildPRTitle, buildPRLabels } = await import('../services/pr-body-builder.js');

            const db = await getDb();
            const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

            if (!artifact?.branchName) {
              throw new Error('No branch name found in artifact');
            }

            // Commit changes in worktree before push
            const agent = mastra?.getAgent('codingAgent');
            if (agent) {
              await agent.generate(
                `W worktree zadania ${taskId}: wykonaj git add . && git commit -m "agent(patch): ${taskId}" jeśli są niezacommitowane zmiany. Odpowiedz krótko.`,
              );
            }

            // Push branch to remote
            const pushResult = await pushBranch(artifact.branchName);
            if (!pushResult.success) {
              throw new Error(`Push failed: ${pushResult.message}`);
            }

            // Build PR content
            const prBody = buildPRBody({
              taskId,
              diagnosticPlan: artifact.diagnosticPlan,
              dispatchResult: artifact.dispatchResult,
              reviewVerdict: verdict,
              reviewComments: comments,
              reviewIteration: iteration,
            });
            const prTitle = buildPRTitle(taskId, artifact.diagnosticPlan);
            const prLabels = buildPRLabels({
              taskId,
              diagnosticPlan: artifact.diagnosticPlan,
              dispatchResult: artifact.dispatchResult,
            });

            // Create PR on GitHub
            const prResult = await createPR({
              branch: artifact.branchName,
              title: prTitle,
              body: prBody,
              labels: prLabels,
            });

            if (!prResult.success) {
              throw new Error(`PR creation failed: ${prResult.message}`);
            }

            // Store PR info in artifact
            await db.collection('code_task_artifacts').updateOne(
              { taskId },
              {
                $set: {
                  prNumber: prResult.prNumber,
                  prUrl: prResult.prUrl,
                  updatedAt: new Date().toISOString(),
                },
              },
            );

            // Wait for CI (non-blocking poll, max 5 min)
            const ciStatus = await waitForCI(prResult.prNumber, { timeoutMs: 300_000 });

            return await suspend({
              taskId,
              verdict,
              comments,
              message: `✅ PR #${prResult.prNumber} created: ${prResult.prUrl}\n` +
                `CI Status: ${ciStatus.state} (${ciStatus.checks.length} checks)\n` +
                `Oczekuję na zatwierdzenie merge (confirmMerge: true).`,
            });
          } catch (prErr) {
            console.error('[decision-gate] PR mode failed, falling back to local merge:', (prErr as Error).message);
            // Fall through to legacy below
          }
        }

        // Resume: merge PR via API
        if (resumeData?.confirmMerge) {
          try {
            const { mergePR, deleteRemoteBranch } = await import('../services/github.js');

            const db = await getDb();
            const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

            if (artifact?.prNumber) {
              // Squash merge PR
              const mergeResult = await mergePR(artifact.prNumber, 'squash');

              if (mergeResult.success) {
                // Cleanup remote branch
                if (artifact.branchName) {
                  await deleteRemoteBranch(artifact.branchName);
                }

                // Pull merged changes to local
                try {
                  const { execSync } = await import('child_process');
                  execSync('git pull origin master', {
                    cwd: AGENTIC_AGENTS_REPO,
                    encoding: 'utf-8',
                    timeout: 30_000,
                  });
                } catch { /* non-fatal */ }

                // Cleanup local worktree
                const cleanupAgent = mastra?.getAgent('codingAgent');
                if (cleanupAgent) {
                  await cleanupAgent.generate(
                    `Użyj coding_remove_worktree z taskId="${taskId}" aby posprzątać zasoby worktree.`,
                  );
                }

                return {
                  taskId,
                  action: 'approved_and_merged' as const,
                  message: `PR #${artifact.prNumber} squash-merged do master. Branch ${artifact.branchName} usunięty.`,
                };
              } else {
                return {
                  taskId,
                  action: 'blocked' as const,
                  message: `PR merge failed: ${mergeResult.message}`,
                };
              }
            }
          } catch (mergeErr) {
            console.error('[decision-gate] PR merge failed:', (mergeErr as Error).message);
          }
        }

        if (resumeData && !resumeData.confirmMerge) {
          return {
            taskId,
            action: 'blocked' as const,
            message: `Użytkownik odrzucił merge dla ${taskId}.`,
          };
        }
      }

      // ═══════════════════════════════════════════════════════════
      // PATH B: Legacy Local Merge
      // ═══════════════════════════════════════════════════════════
      if (!resumeData) {
        return await suspend({
          taskId,
          verdict,
          comments,
          message: `✅ Code Review APPROVED (iteracja ${iteration}). Oczekuję na zatwierdzenie scalania (confirmMerge: true) przez człowieka.`,
        });
      }

      if (resumeData.confirmMerge) {
        const agent = mastra?.getAgent('codingAgent');
        if (!agent) throw new Error('codingAgent not found for merge');

        await agent.generate(`Użyj narzędzia coding_apply_patch z taskId="${taskId}" aby scalić zatwierdzone zmiany do głównego repozytorium. Następnie użyj coding_remove_worktree z taskId="${taskId}" aby posprzątać zasoby worktree.`);

        return {
          taskId,
          action: 'approved_and_merged' as const,
          message: `Zmiany zadania ${taskId} zostały scalone do repozytorium live i worktree usunięty.`,
        };
      } else {
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
      Popraw kod w worktree zgodnie z uwagami. Gdy skończysz poprawki, zaktualizuj artefakt (coding_update_artifact) i ustaw status na waiting_approval.`);

      // Teraz ponownie uruchamiamy review
      const reviewAgent = mastra?.getAgent('codeReviewAgent');
      if (!reviewAgent) throw new Error('codeReviewAgent not found for re-review');

      const nextIteration = iteration + 1;

      await reviewAgent.generate(
        `Zadanie ${taskId} zostało poprawione (iteracja ${nextIteration}/${MAX_REVIEW_ITERATIONS}).
      Pobierz artefakt i przeprowadź ponowne Code Review.
      Użyj submitReviewTool aby zaktualizować werdykt.`,
        anthropicCacheOptions(),
      );

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
            await mergeAgent.generate(`Użyj narzędzia coding_apply_patch z taskId="${taskId}" i następnie coding_remove_worktree z taskId="${taskId}".`);
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
  description: 'Buduje i weryfikuje nowy kod w staging. Z DEPLOY_AUTO_SWAP=true robi pełny swap + watchdog.',
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

      // Etap 10: tryb swap (--dry-run vs pełny swap z watchdog)
      const autoSwap = process.env.DEPLOY_AUTO_SWAP === 'true';
      const mode = autoSwap ? '' : '--dry-run';
      const timeout = autoSwap ? 300_000 : 180_000;  // 5 min dla swap, 3 min dla dry-run

      console.log(`[deploy-and-verify] Mode: ${autoSwap ? 'FULL SWAP + watchdog' : 'dry-run (safe)'}`);

      const output = execSync(`bash "${scriptPath}" ${mode}`, {
        encoding: 'utf-8',
        timeout,
        cwd: projectRoot,
      });

      // Sprawdź wynik
      const isDryRunSuccess = output.includes('DRY RUN COMPLETE');
      const isSwapSuccess = output.includes('SWAP COMPLETE') || output.includes('DEPLOY COMPLETE');
      const isHealthy = isDryRunSuccess || isSwapSuccess;

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

      const modeLabel = autoSwap
        ? 'Swap wykonany, watchdog uruchomiony (10 min obserwacji)'
        : 'Staging zbudowany i zweryfikowany (dry-run)';

      return {
        taskId: inputData.taskId,
        deployStatus: isHealthy ? 'deployed_and_verified' as const : 'deploy_failed' as const,
        version,
        message: isHealthy
          ? `${modeLabel}. Wersja: ${version}.`
          : `Deploy ${autoSwap ? 'swap' : 'dry-run'} nie potwierdził zdrowia.`,
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
