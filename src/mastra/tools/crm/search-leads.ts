/**
 * CRM: Search leads tool (real MongoDB implementation).
 * Replaces: crm-tools.ts (legacy file with direct MongoClient).
 * Uses shared getDb() singleton from lib/mongo.ts.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';

export const CRM_STATUSES = [
  'research_needed',
  'draft_gotowy',
  'followup_draft_gotowy',
  'sent',
  'odpowiedział',
  'zainteresowany',
  'aktywny_klient',
  'opt-out',
  'brak_odpowiedzi',
  'wysłany_email_1',
  'wysłany_email_2',
  'wysłany_email_3',
  'zarejestrowany',
] as const;

export type CrmStatus = (typeof CRM_STATUSES)[number];

const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const optionalDateString = (value: unknown): string | undefined => {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return optionalString(value);
  if (typeof (value as { toISOString?: unknown }).toISOString === 'function') {
    return (value as { toISOString: () => string }).toISOString();
  }
  return undefined;
};

export const searchLeadsTool = createTool({
  id: 'crm.search_leads',
  description: 'Wyszukuje leady w CRM MongoDB. Filtruje po nazwie firmy/emailu, regionie i statusie. Zwraca listę leadów z historią interakcji.',
  inputSchema: z.object({
    query: z.string().optional().describe('Fraza do szukania w nazwie firmy lub emailu (regex, case-insensitive)'),
    region: z.string().optional().describe('Region leada, np. "Mazowieckie", "Kujawsko-Pomorskie"'),
    status: z.enum(CRM_STATUSES).optional().describe('Status leada w CRM'),
    segment: z.string().optional().describe('Segment: producer, restaurant, distributor'),
    limit: z.number().optional().default(10).describe('Limit wyników (domyślnie 10)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    leads: z.array(z.object({
      id: z.string().optional(),
      companyName: z.string().optional(),
      email: z.string().optional(),
      contactName: z.string().optional(),
      status: z.string().optional(),
      region: z.string().optional(),
      segment: z.string().optional(),
      lastInteractionAt: z.string().optional(),
      website: z.string().optional(),
    })),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const collection = db.collection('leads');

      const filter: Record<string, unknown> = {};

      if (context.query) {
        filter.$or = [
          { companyName: { $regex: context.query, $options: 'i' } },
          { email: { $regex: context.query, $options: 'i' } },
          { contactName: { $regex: context.query, $options: 'i' } },
        ];
      }
      if (context.region) filter.region = { $regex: context.region, $options: 'i' };
      if (context.status) filter.status = context.status;
      if (context.segment) filter.segment = context.segment;

      const leads = await collection
        .find(filter)
        .sort({ lastInteractionAt: -1 })
        .limit(context.limit ?? 10)
        .toArray();

      return {
        success: true,
        count: leads.length,
        leads: leads.map(l => ({
          id: optionalString(l.id) ?? String(l._id),
          companyName: optionalString(l.companyName),
          email: optionalString(l.email),
          contactName: optionalString(l.contactName),
          status: optionalString(l.status),
          region: optionalString(l.region),
          segment: optionalString(l.segment),
          lastInteractionAt: optionalDateString(l.lastInteractionAt),
          website: optionalString(l.website),
        })),
      };
    } catch (error) {
      return { success: false, count: 0, leads: [], error: (error as Error).message };
    }
  },
});
