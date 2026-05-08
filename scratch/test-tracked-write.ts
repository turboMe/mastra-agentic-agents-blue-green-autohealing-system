import { randomUUID } from 'crypto';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createCodeTaskArtifactTool } from '../src/mastra/tools/dev/code-task-artifacts.js';
import { writeFileTrackedTool, rejectFileChangeTool } from '../src/mastra/tools/dev/code-change-ledger.js';

async function invokeTool(tool: any, args: any) {
  // W Mastra core narzędzie bezpośrednio bierze zwalidowane argumenty do execute(payload)
  return tool.execute(args);
}

async function runTest() {
  const taskId = `test-task-${randomUUID()}`;
  const testFilePath = 'scratch/test-file.txt';

  console.log(`[TEST] Rozpoczynam cykl życia pliku dla taska: ${taskId}`);

  try {
    // 1. Tworzenie artefaktu
    console.log('[TEST] 1. Tworzenie artefaktu...');
    const createRes = await invokeTool(createCodeTaskArtifactTool, {
      taskId,
      userRequest: 'Test tracked_write',
      agentId: 'codingAgent',
    });
    console.log('Result:', createRes);

    // 2. Tracked Write
    console.log('[TEST] 2. Zapisywanie pliku przez tracked_write...');
    const writeRes = await invokeTool(writeFileTrackedTool, {
      taskId,
      path: testFilePath,
      content: 'Wersja agenta 1.0',
      summary: 'Dodanie pierwszego pliku',
    });
    console.log('Result:', writeRes);

    if (!writeRes.success) throw new Error('Nie udało się zapisać pliku.');

    // 3. Weryfikacja zawartości
    const contentAfterAgent = await readFile(testFilePath, 'utf-8');
    if (contentAfterAgent !== 'Wersja agenta 1.0') throw new Error('Zawartość pliku się nie zgadza.');

    // 4. Manualna edycja (Symulacja usera)
    console.log('[TEST] 3. Symulowanie manualnej edycji użytkownika (konflikt)...');
    await writeFile(testFilePath, 'Wersja agenta 1.0 + MOJE ZMIANY', 'utf8');

    // 5. Odrzucenie zmian agenta (powinno wykryć konflikt)
    console.log('[TEST] 4. Próba rollbacku zmian agenta przez reject_file...');
    const rejectRes = await invokeTool(rejectFileChangeTool, {
      taskId,
      path: testFilePath,
    });
    console.log('Result:', rejectRes);

    if (rejectRes.status === 'conflict') {
      console.log('[TEST SUCCESS] Sukces! Wykryto konflikt, rollback zablokowany.');
    } else {
      console.log('[TEST FAILED] Oczekiwano konfliktu, ale otrzymano:', rejectRes.status);
    }
  } catch (error) {
    console.error('[TEST ERROR]', error);
  }
}

runTest();
