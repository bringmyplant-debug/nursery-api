import { EventTypes } from "@nursery-co/contracts";
import { type Database, type SqlClient, enqueueEvent } from "@nursery-co/platform";
import {
  type Observation,
  type StoredState,
  type Transition,
  decideTransition,
  republishTransition,
} from "./sellability.logic";

const PRODUCER = "partner";

/**
 * One nursery's facts, computed in SQL so the rule is evaluated against a
 * single consistent snapshot and `now()` is the database's clock, not an
 * application server's.
 *
 * Mirrors the monolith's `visibleStock` predicate exactly:
 *   nursery ACTIVE and a subscription that is ACTIVE/TRIALING and unexpired.
 */
const OBSERVE = `
  SELECT n.id                         AS "nurseryId",
         n.city                       AS city,
         (n.status = 'ACTIVE')        AS active,
         EXISTS (
           SELECT 1 FROM subscriptions s
            WHERE s."nurseryId" = n.id
              AND s.status IN ('ACTIVE', 'TRIALING')
              AND s."currentPeriodEnd" > now()
         )                            AS "liveSubscription"
    FROM nurseries n`;

/** Nurseries whose announced state is missing or no longer matches. */
const DRIFTED = `
  SELECT o."nurseryId"
    FROM (${OBSERVE}) o
    LEFT JOIN nursery_sellability s ON s."nurseryId" = o."nurseryId"
   WHERE s."nurseryId" IS NULL
      OR s.sellable <> (o.active AND o."liveSubscription")
      OR s.city <> o.city`;

/**
 * Keeps the announced sellability of each nursery in step with the data,
 * and announces every change through the outbox.
 *
 * Plain class over {@link Database}, deliberately not a Nest provider, so
 * the seed script can run the same code path the service does.
 */
export class SellabilityEngine {
  constructor(private readonly db: Database) {}

  /**
   * Re-evaluate one nursery. Call after anything that can change its
   * answer: a status change, a subscription edit, a move.
   */
  async reconcileNursery(nurseryId: string, correlationId?: string): Promise<Transition | null> {
    return this.db.transaction(async (tx) => {
      const observed = await this.observeLocked(tx, nurseryId);
      if (!observed) return null;

      const transition = decideTransition(await this.stored(tx, nurseryId), observed);
      if (transition) await this.apply(tx, nurseryId, transition, correlationId);
      return transition;
    });
  }

  /**
   * The periodic sweep. Catches what no write triggers — chiefly a
   * subscription crossing its end date, which is the passage of time, not
   * an update. (The monolith evaluated expiry at query time; with stock
   * visibility now precomputed elsewhere, something has to notice.)
   */
  async reconcileDrifted(): Promise<number> {
    const drifted = await this.db.$queryRawUnsafe<{ nurseryId: string }[]>(DRIFTED);
    let changed = 0;
    for (const { nurseryId } of drifted) {
      // Each in its own transaction: re-observes under lock, so a nursery
      // fixed in the meantime is simply a no-op.
      if (await this.reconcileNursery(nurseryId)) changed++;
    }
    return changed;
  }

  /** Re-announce every nursery's current state. See {@link republishTransition}. */
  async republishAll(): Promise<number> {
    const ids = await this.db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM nurseries`);
    for (const { id } of ids) {
      await this.db.transaction(async (tx) => {
        const observed = await this.observeLocked(tx, id);
        if (!observed) return;
        await this.apply(tx, id, republishTransition(await this.stored(tx, id), observed));
      });
    }
    return ids.length;
  }

  /** Locks the nursery row so concurrent reconciles of one nursery queue up rather than race on the version. */
  private async observeLocked(tx: SqlClient, nurseryId: string): Promise<Observation | null> {
    const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM nurseries WHERE id = $1::uuid FOR UPDATE`,
      nurseryId,
    );
    if (locked.length === 0) return null;
    const [row] = await tx.$queryRawUnsafe<Observation[]>(`${OBSERVE} WHERE n.id = $1::uuid`, nurseryId);
    return row ?? null;
  }

  private async stored(tx: SqlClient, nurseryId: string): Promise<StoredState | null> {
    const [row] = await tx.$queryRawUnsafe<StoredState[]>(
      `SELECT city, sellable, version FROM nursery_sellability WHERE "nurseryId" = $1::uuid`,
      nurseryId,
    );
    return row ?? null;
  }

  /** State row and event in one transaction: they exist together or not at all. */
  private async apply(
    tx: SqlClient,
    nurseryId: string,
    t: Transition,
    correlationId?: string,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO nursery_sellability ("nurseryId", city, sellable, version, "updatedAt")
       VALUES ($1::uuid, $2, $3::boolean, $4::int, now())
       ON CONFLICT ("nurseryId") DO UPDATE
         SET city = EXCLUDED.city, sellable = EXCLUDED.sellable,
             version = EXCLUDED.version, "updatedAt" = now()`,
      nurseryId,
      t.city,
      t.sellable,
      t.version,
    );
    await enqueueEvent(tx, PRODUCER, {
      type: EventTypes.PartnerSellabilityChanged,
      data: { nurseryId, city: t.city, sellable: t.sellable, reason: t.reason, version: t.version },
      correlationId,
    });
  }
}
