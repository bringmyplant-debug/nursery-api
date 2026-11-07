import { Logger } from "@nestjs/common";
import type { EventEnvelope } from "@nursery-co/contracts";
import type { Database, SqlClient } from "../sql";
import type { DeliveryMeta } from "./bus";
import {
  type DeadLetterStore,
  type ProcessedStore,
  PostgresDeadLetterStore,
  PostgresProcessedStore,
} from "./stores";

export type EventHandler = (tx: SqlClient, event: EventEnvelope) => Promise<void>;

export interface ConsumerOptions {
  /** After this many failed deliveries the event is parked in dead_letters and acknowledged. */
  maxAttempts?: number;
  /** Runs after a handler's transaction committed (e.g. to kick an outbox relay). */
  onCommitted?: (event: EventEnvelope) => void;
}

export type ConsumeResult = "processed" | "duplicate" | "dead-lettered";

/**
 * Idempotent event handling.
 *
 * The "have I seen this id" mark and the handler's own writes share one
 * transaction. That is the whole trick: if the handler throws, the mark
 * rolls back with it, so the redelivery is processed as the first attempt
 * it really is; if it commits, a later redelivery finds the mark and is
 * skipped. Marking before the transaction, or after it, each leave a
 * window in which an event is either lost or applied twice.
 */
export class EventConsumer {
  private readonly logger: Logger;
  private readonly maxAttempts: number;

  constructor(
    private readonly name: string,
    private readonly db: Database,
    private readonly processed: ProcessedStore = new PostgresProcessedStore(),
    private readonly deadLetters: DeadLetterStore = new PostgresDeadLetterStore(),
    private readonly options: ConsumerOptions = {},
  ) {
    this.logger = new Logger(`Consumer:${name}`);
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  /**
   * Resolves when the event is finished with — processed, skipped as a
   * duplicate, or parked as a dead letter — so the bus should acknowledge
   * it. Rejects only when it should be redelivered.
   */
  async consume(event: EventEnvelope, meta: DeliveryMeta, handler: EventHandler): Promise<ConsumeResult> {
    try {
      const first = await this.db.transaction(async (tx) => {
        if (!(await this.processed.markProcessed(tx, this.name, event.id))) return false;
        await handler(tx, event);
        return true;
      });
      if (!first) return "duplicate";
      this.options.onCommitted?.(event);
      return "processed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (meta.deliveryCount < this.maxAttempts) throw error;

      // Out of attempts. Park it where an operator can see it, and
      // acknowledge so one poison message cannot block everything behind it.
      this.logger.error(
        `giving up on ${event.type} ${event.id} after ${meta.deliveryCount} deliveries: ${message}`,
      );
      await this.deadLetters.record(this.db, {
        consumer: this.name,
        envelope: event,
        error: message,
        attempts: meta.deliveryCount,
      });
      return "dead-lettered";
    }
  }
}
