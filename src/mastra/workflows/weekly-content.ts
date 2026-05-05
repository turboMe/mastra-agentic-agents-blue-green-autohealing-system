import { createWorkflow, createStep } from '@mastra/core/workflows';
import { marketingAgent } from '../agents/marketing-agent';
import { z } from 'zod';

const fetchNewsStep = createStep({
  id: 'fetch-news',
  inputSchema: z.object({}),
  outputSchema: z.object({
    articles: z.array(z.string())
  }),
  execute: async (_context) => {
    console.log('Fetching news...');
    return { articles: ['Wiadomość 1', 'Wiadomość 2'] };
  }
});

const generateDigestStep = createStep({
  id: 'generate-digest',
  inputSchema: z.object({
    articles: z.array(z.string())
  }),
  outputSchema: z.object({
    draft: z.string()
  }),
  execute: async (context) => {
    console.log('Generating digest with Marketing Agent...');
    const result = await marketingAgent.generate(
      `Podsumuj następujące artykuły dla newslettera: ${context.inputData.articles.join(', ')}`
    );
    return { draft: result.text };
  }
});

const saveDraftStep = createStep({
  id: 'save-draft',
  inputSchema: z.object({
    draft: z.string()
  }),
  outputSchema: z.object({
    status: z.string()
  }),
  execute: async (_context) => {
    console.log('Saving draft to CRM/Gmail...');
    return { status: 'Draft Gotowy' };
  }
});

export const weeklyContentWorkflow = createWorkflow({
  id: 'weekly-content',
  inputSchema: z.object({}),
  outputSchema: z.object({
    status: z.string()
  })
})
  .then(fetchNewsStep)
  .then(generateDigestStep)
  .then(saveDraftStep);

weeklyContentWorkflow.commit();
