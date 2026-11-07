import type { EventEnvelope } from "@nursery-co/contracts";
import type { SqlClient } from "../sql";

/**
 * Storage for the three messaging tables every service carries.
 *
 * The table definitions themselves live in each service's Prisma schema —
 * it has to own its migrations — and MUST match the columns used below:
 *
 *   outbox(id uuid pk, seq bigserial unique, type text, payload jsonb,
 *          created_at timestamptz, published_at timestamptz null,
 *          attempts int, last_error text null)
 *   processed_events(consumer text, event_id uuid, processed_at timestamptz,
 *                    primary key (consumer, event_id))
 *   dead_letters(id uuid pk, consumer text, event_id uuid, type text,
 *                payload jsonb, error text, attempts int,
 *                created_at timestamptz, resolved_at timestamptz null)
 *
 * They are interfaces first so the logic that uses them — ordering,
 * retry, idempotency — is testable without a database. The Postgres
 * implementations are exercised end-to-end instead.
 */

/* ------------------------------------------------------------------ outbox */

export interface OutboxRow {
  id: string;
  envelope: EventEnvelope;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number | null;
}

export interface OutboxStore {
  /** Insert in the caller's transaction, so the event commits with the write that caused it. */
  add(tx: SqlClient, envelope: EventEnvelope): Promise<void>;
  /** Lock and return the oldest unpublished events, in insertion order. */
  claim(tx: SqlClient, limit: number): Promise<OutboxRow[]>;
  markPublished(tx: SqlClient, ids: string[]): Promise<void>;
  recordFailure(tx: SqlClient, id: string, error: string): Promise<void>;
  purgePublished(db: SqlClient, olderThanDays: number): Promise<number>;
  stats(db: SqlClient): Promise<OutboxStats>;
}

export class PostgresOutboxStore implements OutboxStore {
  async add(tx: SqlClient, envelope: EventEnvelope): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO outbox (id, type, payload) VALUES ($1::uuid, $2, $3::jsonb)`,
      envelope.id,
      envelope.type,
      JSON.stringify(envelope),
    );
  }

  async claim(tx: SqlClient, limit: number): Promise<OutboxRow[]> {
    // SKIP LOCKED: replicas of one service each take a different slice
    // rather than queueing behind each other's locks.
    const rows = await tx.$queryRawUnsafe<{ id: string; payload: unknown }[]>(
      `SELECT id, payload FROM outbox
        WHERE published_at IS NULL
        ORDER BY seq
        LIMIT $1::int
        FOR UPDATE SKIP LOCKED`,
      limit,
    );
    return rows.map((row) => ({
      id: row.id,
      // jsonb comes back parsed; be tolerant of a driver that returns text.
      envelope: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as EventEnvelope,
    }));
  }

  async markPublished(tx: SqlClient, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.$executeRawUnsafe(
      `UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])`,
      ids,
    );
  }

  async recordFailure(tx: SqlClient, id: string, error: string): Promise<void> {
    await tx.$executeRawUnsafe(
      `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1::uuid`,
      id,
      error.slice(0, 500),
    );
  }

  async purgePublished(db: SqlClient, olderThanDays: number): Promise<number> {
    return db.$executeRawUnsafe(
      `DELETE FROM outbox
        WHERE published_at IS NOT NULL
          AND published_at < now() - ($1::int * interval '1 day')`,
      olderThanDays,
    );
  }

  async stats(db: SqlClient): Promise<OutboxStats> {
    const [row] = await db.$queryRawUnsafe<{ pending: number; age: number | null }[]>(
      `SELECT count(*)::int AS pending,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::float8 AS age
         FROM outbox WHERE published_at IS NULL`,
    );
    return { pending: row?.pending ?? 0, oldestPendingAgeSeconds: row?.age ?? null };
  }
}

/* ------------------------------------------------------- processed events */

export interface ProcessedStore {
  /**
   * Record that `consumer` has handled `eventId`. Resolves true the first
   * time and false for every repeat. Must run in the same transaction as
   * the handler's own writes: if the handler fails, the mark rolls back
   * with it and the retry is treated as the first attempt it really is.
   */
  markProcessed(tx: SqlClient, consumer: string, eventId: string): Promise<boolean>;
  purge(db: SqlClient, olderThanDays: number): Promise<number>;
}

export class PostgresProcessedStore implements ProcessedStore {
  async markProcessed(tx: SqlClient, consumer: string, eventId: string): Promise<boolean> {
    const inserted = await tx.$executeRawUnsafe(
      `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2::uuid)
         ON CONFLICT (consumer, event_id) DO NOTHING`,
      consumer,
      eventId,
    );
    return inserted === 1;
  }

  async purge(db: SqlClient, olderThanDays: number): Promise<number> {
    return db.$executeRawUnsafe(
      `DELETE FROM processed_events WHERE processed_at < now() - ($1::int * interval '1 day')`,
      olderThanDays,
    );
  }
}

/* ------------------------------------------------------------ dead letters */

export interface DeadLetter {
  consumer: string;
  envelope: EventEnvelope;
  error: string;
  attempts: number;
}

export interface DeadLetterStore {
  record(db: SqlClient, entry: DeadLetter): Promise<void>;
  countUnresolved(db: SqlClient): Promise<number>;
}

export class PostgresDeadLetterStore implements DeadLetterStore {
  async record(db: SqlClient, entry: DeadLetter): Promise<void> {
    await db.$executeRawUnsafe(
      `INSERT INTO dead_letters (consumer, event_id, type, payload, error, attempts)
       VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6::int)`,
      entry.consumer,
      entry.envelope.id,
      entry.envelope.type,
      JSON.stringify(entry.envelope),
      entry.error.slice(0, 1000),
      entry.attempts,
    );
  }

  async countUnresolved(db: SqlClient): Promise<number> {
    const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM dead_letters WHERE resolved_at IS NULL`,
    );
    return row?.n ?? 0;
  }
}
