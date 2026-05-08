import { mastra } from '../src/mastra';

async function main() {
  console.log('🚀 Rozpoczynamy symulację workflow repo-maintenance...');
  
  const workflow = mastra.getWorkflow('repoMaintenanceWorkflow');
  
  if (!workflow) {
    console.error('❌ Nie znaleziono repo-maintenance-workflow!');
    process.exit(1);
  }

  try {
    const run = await workflow.execute({
      triggerData: {
        userRequest: 'Proszę stworzyć prosty plik testowy w folderze scratch/ z napisem console.log("Hello from Worktree!") i sprawdzić czy linter to puszcza.',
      }
    } as any);

    console.log('✅ Workflow pomyślnie wystartował!');
    console.log('Run ID:', run.runId);
    console.log('Wynik z Code Review:', run.results);
    
  } catch (error) {
    console.error('❌ Błąd podczas wykonywania workflow:', error);
  }
}

main();
