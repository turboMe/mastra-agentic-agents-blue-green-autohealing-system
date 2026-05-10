/**
 * CRM: Add interaction/note to lead history (real MongoDB).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';

export const addInteractionTool = createTool({
  id: 'crm_add_interaction',
  description: 'Dodaje notatkę lub wpis o interakcji do historii leada (spotkanie, email, telefon, draft). Nie zmienia statusu — używaj crm.update_status jeśli status też się zmienia.',
  inputSchema: z.object({
    idOrEmail: z.string().describe('ID leada (UUID) lub email kontaktu'),
    action: z.string().optional().default('note').describe('Typ akcji: note, call, meeting, email, draft_created, draft_sent'),
    description: z.string().describe('Opis interakcji (pojawi się w historii leada)'),
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

      const isEmail = context.idOrEmail.includes('@');
      const filter = isEmail ? { email: context.idOrEmail } : { id: context.idOrEmail };

      const historyEntry = {
        timestamp: now,
        action: context.action ?? 'note',
        description: context.description,
        agentId: context.agentId ?? 'meta-agent',
      };

      const result = await col.updateOne(filter, {
        $push: { history: historyEntry as any },
        $set: { lastInteractionAt: now, updatedAt: now },
      });

      if (result.matchedCount === 0) {
        return { success: false, message: `Lead nie znaleziony: ${context.idOrEmail}` };
      }

      return { success: true, message: `Interakcja dodana do ${context.idOrEmail}: ${context.action}` };
    } catch (error) {
      return { success: false, message: 'Błąd zapisu interakcji', error: (error as Error).message };
    }
  },
});
