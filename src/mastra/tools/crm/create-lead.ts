/**
 * CRM: Create/upsert lead tool (real MongoDB implementation).
 * Upserts on email (if provided) or companyName+website.
 * Replaces stub that returned mock data.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { CRM_STATUSES } from './search-leads.js';
import { randomUUID } from 'crypto';

export const createLeadTool = createTool({
  id: 'crm_create_lead',
  description: 'Tworzy lub aktualizuje leada w CRM (upsert po email lub firmie). Używaj do dodawania nowych producentów, importu kontaktów z Gmail, lub odtwarzania danych po enrichmencie.',
  inputSchema: z.object({
    companyName: z.string().min(1).describe('Nazwa firmy (wymagana)'),
    email: z.string().email().optional().describe('Email kontaktu (służy jako klucz upsert)'),
    contactName: z.string().optional(),
    phone: z.string().optional(),
    segment: z.string().optional().default('producer').describe('producer | restaurant | distributor | other'),
    region: z.string().optional(),
    website: z.string().optional(),
    linkedIn: z.string().optional(),
    tags: z.array(z.string()).optional().default([]),
    status: z.enum(CRM_STATUSES).optional().default('research_needed'),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    leadId: z.string().optional(),
    action: z.enum(['created', 'updated']).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const col = db.collection('leads');
      const now = new Date();

      // Match on email (preferred) or companyName
      const matchFilter = context.email
        ? { email: context.email }
        : { companyName: { $regex: `^${context.companyName}$`, $options: 'i' } };

      const existing = await col.findOne(matchFilter);

      if (existing) {
        // Update existing
        await col.updateOne(matchFilter, {
          $set: {
            companyName: context.companyName,
            ...(context.email && { email: context.email }),
            ...(context.contactName && { contactName: context.contactName }),
            ...(context.phone && { phone: context.phone }),
            ...(context.segment && { segment: context.segment }),
            ...(context.region && { region: context.region }),
            ...(context.website && { website: context.website }),
            ...(context.linkedIn && { linkedIn: context.linkedIn }),
            ...(context.metadata && { metadata: { ...existing.metadata, ...context.metadata } }),
            updatedAt: now,
          },
          $addToSet: { tags: { $each: context.tags ?? [] } },
        });
        return { success: true, leadId: existing.id as string, action: 'updated' as const, message: `Lead zaktualizowany: ${context.companyName}` };
      }

      // Create new
      const id = randomUUID();
      await col.insertOne({
        id,
        companyName: context.companyName,
        email: context.email ?? null,
        contactName: context.contactName ?? null,
        phone: context.phone ?? null,
        segment: context.segment ?? 'producer',
        region: context.region ?? null,
        website: context.website ?? null,
        linkedIn: context.linkedIn ?? null,
        tags: context.tags ?? [],
        status: context.status ?? 'research_needed',
        metadata: context.metadata ?? {},
        history: [],
        createdAt: now,
        updatedAt: now,
        lastInteractionAt: now,
      });

      return { success: true, leadId: id, action: 'created' as const, message: `Lead utworzony: ${context.companyName}` };
    } catch (error) {
      return { success: false, message: 'Błąd zapisu leada', error: (error as Error).message };
    }
  },
});
