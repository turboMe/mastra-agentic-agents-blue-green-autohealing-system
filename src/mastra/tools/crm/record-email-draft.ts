/**
 * CRM: Record email draft in lead metadata (real MongoDB).
 * Sets status to 'draft_gotowy', stores draft (subject + body + ids) in metadata.draft,
 * does NOT overwrite enrichment data in metadata. Appends to history.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';

export const recordEmailDraftTool = createTool({
  id: 'crm_record_email_draft',
  description:
    'Zapisuje aktualny draft maila do leada (metadata.draft) bez nadpisywania innych metadanych. Ustawia status "draft_gotowy" i dodaje wpis do historii.',
  inputSchema: z.object({
    idOrEmail: z.string().describe('ID leada (UUID) lub email kontaktu'),
    draft: z.object({
      subject: z.string(),
      body: z.string(),
      draftId: z.string().optional().describe('Lokalny identyfikator draftu (np. z DraftsStore)'),
      gmailDraftId: z.string().optional().describe('Identyfikator z Gmail API'),
      sourceDraftId: z.string().optional().describe('Identyfikator nadrzędnego draftu, jeśli jest to wariant'),
    }),
    reason: z.string().describe('Uzasadnienie (trafia do historii)'),
    agentId: z.string().optional().default('meta-agent'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const col = db.collection('leads');
      const now = new Date();
      const filter = context.idOrEmail.includes('@')
        ? { email: context.idOrEmail }
        : { id: context.idOrEmail };

      const historyEntry = {
        timestamp: now,
        action: 'draft_recorded',
        description: context.reason,
        agentId: context.agentId ?? 'meta-agent',
      };

      const result = await col.updateOne(filter, {
        $set: {
          status: 'draft_gotowy',
          'metadata.draft': { ...context.draft, updatedAt: now },
          updatedAt: now,
          lastInteractionAt: now,
        },
        $push: { history: historyEntry as any },
      });

      if (result.matchedCount === 0) {
        return { success: false, message: `Lead nie znaleziony: ${context.idOrEmail}` };
      }

      return { success: true, message: `Draft zapisany dla ${context.idOrEmail}` };
    } catch (error) {
      return {
        success: false,
        message: 'Błąd zapisu draftu',
        error: (error as Error).message,
      };
    }
  },
});
