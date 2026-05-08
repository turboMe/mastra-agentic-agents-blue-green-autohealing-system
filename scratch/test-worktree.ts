import { randomUUID } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { createCodeTaskArtifactTool, runTestCommandTool } from '../src/mastra/tools/dev/code-task-artifacts.js';
import { writeFileTrackedTool } from '../src/mastra/tools/dev/code-change-ledger.js';
import { initWorktreeTool, removeWorktreeTool, applyWorktreePatchTool } from '../src/mastra/tools/dev/code-worktree.js';
import { AGENTIC_AGENTS_REPO } from '../src/mastra/workspaces/code-workspace.js';

async function invokeTool(tool: any, args: any) {
  return tool.execute(args);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runTest() {
  const taskId = `test-task-${randomUUID()}`;
  const testFilePath = 'scratch/worktree-dummy.txt';

  console.log(`\n[TEST] Rozpoczynam cykl życia WORKTREE dla taska: ${taskId}\n`);

  try {
    // 1. Tworzenie artefaktu
    console.log('[TEST] 1. Tworzenie artefaktu...');
    await invokeTool(createCodeTaskArtifactTool, {
      taskId,
      userRequest: 'Test worktree E2E',
      agentId: 'codingAgent',
    });
    console.log(' -> OK');

    // 2. Inicjalizacja Worktree
    console.log('[TEST] 2. Inicjalizacja worktree (git worktree add)...');
    const initRes = await invokeTool(initWorktreeTool, { taskId });
    console.log(' -> Result:', initRes);

    if (!initRes.success || !initRes.worktreePath) throw new Error('Nie udalo sie zainicjowac worktree.');

    // 3. Sprawdzenie, czy faktycznie folder powstal na dysku
    const isWorktreeOnDisk = await fileExists(initRes.worktreePath);
    if (!isWorktreeOnDisk) throw new Error(`Worktree nie istnieje fizycznie: ${initRes.worktreePath}`);
    console.log(' -> Worktree sprawdzone fizycznie na dysku.');

    // 4. Zapis pliku przez tracked_write wewnatrz worktree
    console.log('[TEST] 3. Zapisywanie pliku przez tracked_write wewnatrz worktree...');
    const writeRes = await invokeTool(writeFileTrackedTool, {
      taskId,
      path: testFilePath,
      content: 'Hello World z Worktree!',
      summary: 'Dodanie testowego pliku',
    });
    console.log(' -> Result:', writeRes);

    if (!writeRes.success) throw new Error('Nie udalo sie zapisać pliku w worktree.');

    // Upewnienie się, że plik fizycznie nie trafił do MAIN REPO!
    const inMainRepo = await fileExists(join(AGENTIC_AGENTS_REPO, testFilePath));
    if (inMainRepo) throw new Error('BŁĄD KRYTYCZNY: Plik wylądował w main repo zamiast w worktree!');
    console.log(' -> Super: Plik nie istnieje w głównym repozytorium.');

    // 5. Test w worktree (np. tsc lub zwykly node)
    console.log('[TEST] 4. Uruchamianie testu wewnatrz worktree...');
    const testRes = await invokeTool(runTestCommandTool, {
      taskId,
      command: 'pwd',
      summary: 'Sprawdzenie czy command wykonuje sie w dobrym katalogu',
    });
    console.log(' -> Result test:', testRes.output.trim());
    if (!testRes.output.includes(taskId)) {
      throw new Error('Wykonano komende w zlym folderze!');
    }

    // 6. The Merge - patch live environment
    console.log('[TEST] 5. Aplikowanie zmian na główne środowisko (git merge)...');
    const applyRes = await invokeTool(applyWorktreePatchTool, {
      taskId,
      commitMessage: 'test: E2E Worktree integration',
    });
    console.log(' -> Result:', applyRes);

    if (!applyRes.success) throw new Error('Apply patch failed.');

    // 7. Sprawdzenie main repo
    console.log('[TEST] 6. Sprawdzanie czy plik fizycznie pojawil sie w glownym środowisku...');
    const nowInMainRepo = await fileExists(join(AGENTIC_AGENTS_REPO, testFilePath));
    if (!nowInMainRepo) throw new Error('Plik nie pojawil sie w main repo po Merge!');
    const content = await readFile(join(AGENTIC_AGENTS_REPO, testFilePath), 'utf-8');
    console.log(` -> OK! Zawartość pliku w głównym repo: "${content}"`);

    // 8. Sprzątanie
    console.log('[TEST] 7. Sprzątanie (remove_worktree)...');
    const rmRes = await invokeTool(removeWorktreeTool, { taskId });
    console.log(' -> Result:', rmRes);

    // Aby zacheowac repozytorium w czystosci usuwamy recznie z main brancha ten testowy plik gitem:
    import('child_process').then(cp => cp.execSync(`git rm ${testFilePath} && git commit -m "chore: cleanup test E2E"`));
    
    console.log('\n[TEST SUCCESS] Symulacja E2E zakończona pełnym sukcesem!');
  } catch (error) {
    console.error('\n[TEST ERROR]', error);
  }
}

runTest();
