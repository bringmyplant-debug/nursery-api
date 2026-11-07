import type { EventEnvelope } from "@nursery-co/contracts";
import type { Database, SqlClient } from "../sql";
import type {
  DeadLetter,
  DeadLetterStore,
  OutboxRow,
  OutboxStats,
  OutboxStore,
  ProcessedStore,
} from "../messaging/stores";

/**
 * In-memory stand-ins for the Postgres stores, plus a {@link Database}
 * whose transactions really roll back.
 *
 * For unit-testing code that uses the outbox and consumers — including,
 * in each service, its own handlers. The SQL in the Postgres stores is
 * verified against a real database instead; what this makes testable is
 * the *logic* around them (ordering, retry, idempotency, atomicity).
 */

export interface MemoryTx extends SqlClient {
  /** Callbacks to run, newest first, if the transaction aborts. */
  undo: (() => void)[];
}

const unsupported = (): never => {
  throw new Error("MemoryDatabase does not execute SQL; use the in-memory stores");
};

export class MemoryDatabase implements Database {
  $queryRawUnsafe = unsupported as Database["$queryRawUnsafe"];
  $executeRawUnsafe = unsupported as Database["$executeRawUnsafe"];

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const tx: MemoryTx = {
      undo: [],
      $queryRawUnsafe: unsupported as never,
      $executeRawUnsafe: unsupported as never,
    };
    try {
      return await fn(tx);
    } catch (error) {
      for (const revert of tx.undo.reverse()) revert();
      throw error;
    }
  }
}

/** Register a rollback if `client` is a transaction; a no-op otherwise. */
export function onRollback(client: SqlClient, revert: () => void): void {
  (client as Partial<MemoryTx>).undo?.push(revert);
}

interface OutboxEntry {
  envelope: EventEnvelope;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

export class MemoryOutboxStore implements OutboxStore {
  readonly entries: OutboxEntry[] = [];

  async add(tx: SqlClient, envelope: EventEnvelope): Promise<void> {
    const entry: OutboxEntry = {
      envelope,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      createdAt: new Date(),
    };
    this.entries.push(entry);
    onRollback(tx, () => this.entries.splice(this.entries.indexOf(entry), 1));
  }

  async claim(_tx: SqlClient, limit: number): Promise<OutboxRow[]> {
    return this.entries
      .filter((e) => e.publishedAt === null)
      .slice(0, limit)
      .map((e) => ({ id: e.envelope.id, envelope: e.envelope }));
  }

  async markPublished(tx: SqlClient, ids: string[]): Promise<void> {
    const touched = this.entries.filter((e) => ids.includes(e.envelope.id));
    for (const e of touched) e.publishedAt = new Date();
    onRollback(tx, () => touched.forEach((e) => (e.publishedAt = null)));
  }

  async recordFailure(_tx: SqlClient, id: string, error: string): Promise<void> {
    const entry = this.entries.find((e) => e.envelope.id === id);
    if (entry) {
      entry.attempts++;
      entry.lastError = error;
    }
  }

  async purgePublished(): Promise<number> {
    return 0;
  }

  async stats(): Promise<OutboxStats> {
    const pending = this.entries.filter((e) => e.publishedAt === null);
    return { pending: pending.length, oldestPendingAgeSeconds: pending.length ? 0 : null };
  }

  get pending(): EventEnvelope[] {
    return this.entries.filter((e) => e.publishedAt === null).map((e) => e.envelope);
  }
}

export class MemoryProcessedStore implements ProcessedStore {
  private readonly seen = new Set<string>();

  async markProcessed(tx: SqlClient, consumer: string, eventId: string): Promise<boolean> {
    const key = `${consumer}:${eventId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    onRollback(tx, () => this.seen.delete(key));
    return true;
  }

  async purge(): Promise<number> {
    return 0;
  }
}

export class MemoryDeadLetterStore implements DeadLetterStore {
  readonly entries: DeadLetter[] = [];

  async record(_db: SqlClient, entry: DeadLetter): Promise<void> {
    this.entries.push(entry);
  }

  async countUnresolved(): Promise<number> {
    return this.entries.length;
  }
}
