/**
 * ErrorCollector — Self-Healing Error Detection Service (Etap 7)
 *
 * Nasłuchuje błędy runtime Mastry i automatycznie inicjuje
 * repo-maintenance-workflow, podając stack trace i kontekst błędu.
 *
 * Mechanizmy bezpieczeństwa:
 * - Deduplikacja wg hash signature (ten sam błąd nie odpala workflow 2x)
 * - Cooldown: min ERROR_COLLECTOR_COOLDOWN_MS ms między triggerami
 * - Limit aktywnych tasków: max ERROR_COLLECTOR_MAX_ACTIVE
 * - TTL: tickety starsze niż ERROR_COLLECTOR_TTL_HOURS h są czyszczone
 * - Self-protection: błędy z samego ErrorCollector NIE triggerują kolejnego heal
 */

import { createHash } from 'crypto';
import { getDb } from '../lib/mongo.js';
import { logAgentEvent } from '../lib/agent-event-log.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ErrorContext {
  /** Where the error was caught: 'uncaughtException' | 'unhandledRejection' | 'workflow' | 'agent' | 'api' */
  source: string;
  /** Optional — which workflow/agent/endpoint produced this error */
  origin?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface HealingTicket {
  ticketId: string;
  errorSignature: string;
  errorMessage: string;
  stackTrace: string;
  context: ErrorContext;
  status: 'pending' | 'in_progress' | 'resolved' | 'failed' | 'expired';
  workflowRunId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: Date;
}

// ── Config ───────────────────────────────────────────────────────────────────

const COOLDOWN_MS = Number(process.env.ERROR_COLLECTOR_COOLDOWN_MS ?? 60_000);
const MAX_ACTIVE = Number(process.env.ERROR_COLLECTOR_MAX_ACTIVE ?? 3);
const TTL_HOURS = Number(process.env.ERROR_COLLECTOR_TTL_HOURS ?? 24);
const ENABLED = (process.env.ERROR_COLLECTOR_ENABLED ?? 'true') !== 'false';

// ── Error Collector ──────────────────────────────────────────────────────────

export class ErrorCollector {
  private lastTriggerTime = 0;
  private selfProtectionStack = false;

  /**
   * Wyznacza unikalną sygnaturę błędu — hash wiadomości + pierwszych 3 linii stack trace.
   * Dzięki temu identyczne błędy z różnych wywołań mają tę samą sygnaturę.
   */
  hashError(error: Error): string {
    const stackLines = (error.stack ?? '').split('\n').slice(0, 4).join('\n');
    const payload = `${error.name}::${error.message}::${stackLines}`;
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /**
   * Główna metoda — zgłoś błąd do systemu self-healing.
   * Decyduje czy odpalić workflow na podstawie deduplikacji, cooldownu i limitów.
   */
  async reportError(error: Error, context: ErrorContext): Promise<{ triggered: boolean; reason: string; ticketId?: string }> {
    if (!ENABLED) {
      return { triggered: false, reason: 'ErrorCollector disabled via ENV' };
    }

    // Self-protection: nie łap błędów z samego siebie
    if (this.selfProtectionStack) {
      return { triggered: false, reason: 'Self-protection: error inside ErrorCollector' };
    }

    this.selfProtectionStack = true;

    try {
      return await this._processError(error, context);
    } catch (collectorError: any) {
      console.error('[ErrorCollector] Internal error (self-protected):', collectorError.message);
      return { triggered: false, reason: `ErrorCollector internal failure: ${collectorError.message}` };
    } finally {
      this.selfProtectionStack = false;
    }
  }

  private async _processError(error: Error, context: ErrorContext): Promise<{ triggered: boolean; reason: string; ticketId?: string }> {
    const signature = this.hashError(error);

    // ── Cooldown check ──
    const now = Date.now();
    if (now - this.lastTriggerTime < COOLDOWN_MS) {
      return { triggered: false, reason: `Cooldown active (${COOLDOWN_MS}ms). Wait ${COOLDOWN_MS - (now - this.lastTriggerTime)}ms.` };
    }

    const db = await getDb();
    const collection = db.collection<HealingTicket>('auto_healing_tickets');

    // ── Deduplikacja — ten sam błąd już w toku? ──
    const existing = await collection.findOne({
      errorSignature: signature,
      status: { $in: ['pending', 'in_progress'] },
    });
    if (existing) {
      return { triggered: false, reason: `Duplicate: healing already in progress for signature ${signature}`, ticketId: existing.ticketId };
    }

    // ── Limit aktywnych tasków ──
    const activeCount = await collection.countDocuments({
      status: { $in: ['pending', 'in_progress'] },
    });
    if (activeCount >= MAX_ACTIVE) {
      return { triggered: false, reason: `Max active healing tasks reached (${MAX_ACTIVE})` };
    }

    // ── Utwórz ticket ──
    const ticketId = `heal-${signature}-${Date.now()}`;
    const ticket: HealingTicket = {
      ticketId,
      errorSignature: signature,
      errorMessage: error.message,
      stackTrace: (error.stack ?? '').slice(0, 8000), // limit do 8KB
      context,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
    };

    await collection.insertOne(ticket as any);

    // ── Trigger workflow ──
    this.lastTriggerTime = Date.now();

    // Fire-and-forget: uruchamiamy workflow asynchronicznie
    this._triggerWorkflow(ticketId, error, context).catch((err) => {
      console.error(`[ErrorCollector] Failed to trigger workflow for ${ticketId}:`, err.message);
      // Oznacz ticket jako failed
      collection.updateOne(
        { ticketId },
        { $set: { status: 'failed', updatedAt: new Date().toISOString() } },
      ).catch(() => {});
    });

    return { triggered: true, reason: 'Workflow triggered', ticketId };
  }

  private async _triggerWorkflow(ticketId: string, error: Error, context: ErrorContext): Promise<void> {
    const db = await getDb();
    const collection = db.collection('auto_healing_tickets');

    try {
      // Dynamiczny import, żeby uniknąć circular dependency z index.ts
      const { mastra } = await import('../index.js');
      const workflow = mastra.getWorkflow('repoMaintenanceWorkflow');

      if (!workflow) {
        throw new Error('repoMaintenanceWorkflow not found in Mastra registry');
      }

      // ── Phase 2.1: Failure Brain — recall known failures before workflow ──
      let knownFailuresSection = '';
      try {
        const { recallKnowledge } = await import('../lib/failure-brain.js');

        const failureCases = await recallKnowledge(
          `${error.name}: ${error.message}`,
          { type: 'failure_case', topK: 3, minScore: 0.4 },
        );
        if (failureCases.length > 0) {
          knownFailuresSection = [
            ``,
            `### Znane podobne awarie z historii systemu:`,
            ...failureCases.map((i: any) =>
              `- **[score: ${i.score.toFixed(2)}]** ${i.title}\n  ${i.content}`
            ),
            ``,
            `Jeśli któraś z powyższych awarii pasuje do bieżącego problemu, użyj opisanego rozwiązania jako bazy.`,
          ].join('\n');
        }

        // Also check autoheal_recipes
        const recipes = await recallKnowledge(
          `${error.name}: ${error.message}`,
          { type: 'autoheal_recipe', topK: 2, minScore: 0.4 },
        );
        if (recipes.length > 0) {
          knownFailuresSection += [
            ``,
            `### Sprawdzone receptury auto-naprawy:`,
            ...recipes.map((i: any) =>
              `- **[score: ${i.score.toFixed(2)}]** ${i.title}\n  ${i.content}`
            ),
          ].join('\n');
        }
      } catch (recallErr) {
        // Non-fatal — workflow proceeds without historical context
        console.warn('[ErrorCollector] Failure Brain recall failed:', (recallErr as Error).message);
      }

      const prompt = [
        `System wykrył błąd runtime wymagający automatycznej naprawy.`,
        ``,
        `Źródło: ${context.source}${context.origin ? ` (${context.origin})` : ''}`,
        `Typ błędu: ${error.name}`,
        `Wiadomość: ${error.message}`,
        ``,
        `Stack trace:`,
        `\`\`\``,
        (error.stack ?? '').slice(0, 4000),
        `\`\`\``,
        ``,
        context.metadata ? `Dodatkowy kontekst: ${JSON.stringify(context.metadata, null, 2)}` : '',
        knownFailuresSection,
        ``,
        `Ticket ID: ${ticketId}`,
        ``,
        `Instrukcja: Zbadaj przyczynę tego błędu w kodzie źródłowym.`,
        knownFailuresSection ? `Sprawdź znane awarie powyżej — jeśli pasują, użyj ich rozwiązania jako bazy.` : '',
        `Znajdź plik i linię odpowiedzialną za problem.`,
        `Przygotuj minimalną poprawkę i przekaż do Code Review.`,
        `Oznacz źródło naprawy jako "system-auto-heal".`,
      ].filter(Boolean).join('\n');

      // Uruchomienie workflow
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {
          userRequest: prompt,
          taskId: ticketId,
        },
      });

      // Zapisz workflowRunId w ticket
      await collection.updateOne(
        { ticketId },
        {
          $set: {
            status: 'in_progress',
            workflowRunId: (run as any).runId ?? 'unknown',
            updatedAt: new Date().toISOString(),
          },
        },
      );

      console.log(`[ErrorCollector] ✅ Workflow triggered for ticket ${ticketId} (run: ${(run as any).runId ?? 'unknown'})`);

      logAgentEvent({
        type: 'autoheal_triggered',
        agentId: 'error-collector',
        taskId: ticketId,
        status: 'pending',
        input: error.message.slice(0, 500),
        metadata: { source: context.source, origin: context.origin, workflowRunId: (run as any).runId },
      });
    } catch (triggerError: any) {
      await collection.updateOne(
        { ticketId },
        { $set: { status: 'failed', updatedAt: new Date().toISOString() } },
      );
      throw triggerError;
    }
  }

  /**
   * Oznacza ticket jako rozwiązany — wywoływane po udanym deploy-and-verify.
   */
  async resolveTicket(ticketId: string): Promise<void> {
    const db = await getDb();
    const ticket = await db.collection<HealingTicket>('auto_healing_tickets').findOne({ ticketId }) as unknown as HealingTicket | null;

    await db.collection('auto_healing_tickets').updateOne(
      { ticketId },
      { $set: { status: 'resolved', updatedAt: new Date().toISOString() } },
    );

    // ── Phase 2.1: Save resolution as autoheal_recipe for future Failure Brain recall ──
    if (ticket) {
      try {
        const { writeKnowledge } = await import('../lib/failure-brain.js');
        await writeKnowledge(
          'autoheal_recipe',
          `Fix: ${ticket.errorMessage.slice(0, 100)}`,
          [
            `Error: ${ticket.errorMessage}`,
            `Source: ${ticket.context.source}${ticket.context.origin ? ` (${ticket.context.origin})` : ''}`,
            `Stack hint: ${(ticket.stackTrace ?? '').split('\n').slice(0, 3).join(' | ')}`,
            `Resolution: ticket ${ticketId} resolved via workflow ${ticket.workflowRunId ?? 'unknown'}`,
          ].join('\n'),
        );
      } catch (writeErr) {
        // Non-fatal — ticket is already resolved
        console.warn('[ErrorCollector] Failed to save autoheal recipe:', (writeErr as Error).message);
      }
    }
  }

  /**
   * Czyści wygasłe tickety (wywoływane okresowo lub przy starcie).
   */
  async cleanupExpired(): Promise<number> {
    const db = await getDb();
    const result = await db.collection('auto_healing_tickets').deleteMany({
      expiresAt: { $lt: new Date() },
    });
    return result.deletedCount;
  }

  /**
   * Zwraca status aktywnych ticketów (do diagnostyki).
   */
  async getActiveTickets(): Promise<HealingTicket[]> {
    const db = await getDb();
    return db.collection<HealingTicket>('auto_healing_tickets')
      .find({ status: { $in: ['pending', 'in_progress'] } })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray() as unknown as HealingTicket[];
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: ErrorCollector | null = null;

export function getErrorCollector(): ErrorCollector {
  if (!_instance) {
    _instance = new ErrorCollector();
  }
  return _instance;
}
