import { Logger } from "@nestjs/common";
import {
  newEventId,
} from "../ids";
import type { EventEnvelope, EventMap, EventType } from "@nursery-co/contracts";
import { retryDelayMs } from "../backoff";
import { PeriodicJob } from "../periodic";
import type { Database, SqlClient } from "../sql";
import type { EventBus } from "./bus";
import { type OutboxStats, type OutboxStore, PostgresOutboxStore } from "./stores";

export interface NewEvent<T extends EventType = EventType> {
  type: T;
  data: EventMap[T];
  correlationId?: string;
}

/**
 * Record an event in the same transaction as the change it announces.
 *
 * This is the whole reason the outbox exists. The alternative — write the
 * row, then publish to the broker — has a window between the two in which
 * a crash leaves the database changed and nobody told. Publishing first
 * has the opposite window: telling everyone about a change that then
 * fails to commit. Writing the event *into the database* with the change
 * closes both: they commit together or not at all, and a separate relay
 * delivers it afterwards, retrying for as long as it takes.
 */
export async function enqueueEvent<T extends EventType>(
  tx: SqlClient,
  producer: string,
  event: NewEvent<T>,
  store: OutboxStore = defaultStore,
): Promise<EventEnvelope<T, EventMap[T]>> {
  const envelope: EventEnvelope<T, EventMap[T]> = {
    id: newEventId(),
    type: event.type,
    occurredAt: new Date().toISOString(),
    producer,
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    data: event.data,
  };
  await store.add(tx, envelope);
  return envelope;
}

const defaultStore = new PostgresOutboxStore();

export interface RelayOptions {
  batchSize?: number;
  pollMs?: number;
  /** Published rows older than this are deleted. Past it, replay comes from the broker. */
  purgeAfterDays?: number;
}

export interface DrainResult {
  published: number;
  /** True when the broker refused an event and the batch stopped early. */
  failed: boolean;
}

const PURGE_EVERY_MS = 10 * 60 * 1000;

/**
 * Moves events from the outbox table to the bus.
 *
 * At-least-once: an event is marked published only after the broker
 * accepted it, so a crash in between publishes it again next time. The
 * broker's id-based de-duplication and the consumers' own idempotency
 * both exist to make that repeat harmless.
 *
 * Order within a batch is preserved by stopping at the first failure
 * rather than skipping it — later events must not overtake an earlier one
 * that has not gone out. Across replicas and across transactions, order is
 * *not* guaranteed (a sequence number is allocated at insert, not at
 * commit), which is why every consumer guards on a per-key version.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly job: PeriodicJob;
  private readonly batchSize: number;
  private readonly purgeAfterDays: number;

  private draining = false;
  private consecutiveFailures = 0;
  private notBefore = 0;
  private lastPurge = 0;

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly store: OutboxStore = defaultStore,
    options: RelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.purgeAfterDays = options.purgeAfterDays ?? 7;
    this.job = new PeriodicJob(() => this.tick(), options.pollMs ?? 500, (error) =>
      this.logger.error(`relay tick failed: ${error instanceof Error ? error.message : error}`),
    );
  }

  /** Nest lifecycle. */
  onApplicationBootstrap(): void {
    this.job.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.job.stop();
  }

  /**
   * Ask for an immediate drain instead of waiting for the next poll.
   * Called after a transaction that enqueued events commits, so the
   * common case is milliseconds rather than half a second. The poll is
   * still what guarantees delivery; this is only an optimisation.
   */
  kick(): void {
    setImmediate(() => {
      this.drain().catch((error) =>
        this.logger.error(`kicked drain failed: ${error instanceof Error ? error.message : error}`),
      );
    });
  }

  async drain(): Promise<DrainResult> {
    if (this.draining) return { published: 0, failed: false };
    this.draining = true;
    try {
      let total = 0;
      for (;;) {
        const batch = await this.drainBatch();
        total += batch.published;
        if (batch.failed || batch.published < this.batchSize) {
          return { published: total, failed: batch.failed };
        }
      }
    } finally {
      this.draining = false;
    }
  }

  stats(): Promise<OutboxStats> {
    return this.store.stats(this.db);
  }

  private async tick(): Promise<void> {
    if (Date.now() >= this.lastPurge + PURGE_EVERY_MS) {
      this.lastPurge = Date.now();
      const purged = await this.store.purgePublished(this.db, this.purgeAfterDays).catch(() => 0);
      if (purged > 0) this.logger.log(`purged ${purged} published outbox rows`);
    }

    // After a failure, wait out a backoff instead of retrying every poll.
    if (Date.now() < this.notBefore) return;

    const result = await this.drain();
    if (result.failed) {
      this.consecutiveFailures++;
      this.notBefore = Date.now() + retryDelayMs(this.consecutiveFailures, { maxMs: 15_000 });
    } else {
      this.consecutiveFailures = 0;
      this.notBefore = 0;
    }
  }

  private drainBatch(): Promise<DrainResult> {
    return this.db.transaction(
      async (tx) => {
        const rows = await this.store.claim(tx, this.batchSize);
        const published: string[] = [];
        let failed = false;

        for (const row of rows) {
          try {
            await this.bus.publish(row.envelope);
            published.push(row.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`publish of ${row.envelope.type} ${row.id} failed: ${message}`);
            await this.store.recordFailure(tx, row.id, message);
            failed = true;
            break;
          }
        }

        // Commits what *did* go out even when a later event failed, so a
        // poison row cannot cause the earlier ones to be re-sent forever.
        await this.store.markPublished(tx, published);
        return { published: published.length, failed };
      },
      // The transaction spans network calls; give it room to finish.
      { timeoutMs: 30_000 },
    );
  }
}
