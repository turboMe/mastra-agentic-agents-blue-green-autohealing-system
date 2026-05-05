import { mastra } from '../src/mastra';

async function main() {
  console.log('🚀 Starting Producer Hunt Workflow test for region: lubelskie');
  
  const workflow = mastra.getWorkflow('producerHuntWorkflow');
  
  try {
    const run = await workflow.execute({
      triggerData: {
        region: 'lubelskie',
        count: 3,
      }
    });

    console.log('✅ Workflow execution started!');
    console.log('Run ID:', run.runId);
    
    // We don't wait for the whole thing here if it's long, 
    // but the execute method in Mastra usually waits unless configured otherwise.
    // Let's see the result.
    console.log('Result status:', run.status);
  } catch (error) {
    console.error('❌ Workflow execution failed:', error);
  }
}

main();
