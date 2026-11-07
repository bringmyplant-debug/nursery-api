import { EventTypes, type SellabilityChangedData } from "@nursery-co/contracts";
import { type Database, type SqlClient, enqueueEvent } from "@nursery-co/platform";
import {
  type HeldAvailability,
  type HeldProjection,
  type Totals,
  affectedCities,
  decideAvailability,
  isNewerThanHeld,
} from "./availability.logic";

const PRODUCER = "inventory";

export interface StockUpdate {
  stock: number;
  reserved?: number;
  isActive?: boolean;
  condition?: "PREMIUM" | "STANDARD" | "NURSERY_FRESH";
}

/**
 * Owns the arithmetic from "nurseries hold stock" to "buyers can have N",
 * and announces every change of N.
 *
 * Plain class over {@link Database} — not a Nest provider — so the seed
 * script runs exactly the code the service does.
 *
 * Every method that changes a total does so inside a transaction that also
 * writes the event, so the total and its announcement exist together or not
 * at all.
 */
export class AvailabilityEngine {
  constructor(private readonly db: Database) {}

  /* ------------------------------------------------- event → projection */

  /**
   * Apply a sellability announcement from the partner service. Runs inside
   * the consumer's transaction (the one that also records the event as
   * processed), hence it takes `tx` rather than opening its own.
   */
  async applySellability(tx: SqlClient, data: SellabilityChangedData): Promise<boolean> {
    const [held] = await tx.$queryRawUnsafe<HeldProjection[]>(
      `SELECT city, sellable, version FROM nursery_projection WHERE "nurseryId" = $1::uuid FOR UPDATE`,
      data.nurseryId,
    );
    if (!isNewerThanHeld(held ?? null, data.version)) return false;

    await tx.$executeRawUnsafe(
      `INSERT INTO nursery_projection ("nurseryId", city, sellable, version, "updatedAt")
       VALUES ($1::uuid, $2, $3::boolean, $4::int, now())
       ON CONFLICT ("nurseryId") DO UPDATE
         SET city = EXCLUDED.city, sellable = EXCLUDED.sellable,
             version = EXCLUDED.version, "updatedAt" = now()`,
      data.nurseryId,
      data.city,
      data.sellable,
      data.version,
    );

    const variants = await tx.$queryRawUnsafe<{ variantId: string }[]>(
      `SELECT DISTINCT "variantId" FROM inventory WHERE "nurseryId" = $1::uuid`,
      data.nurseryId,
    );
    for (const city of affectedCities(held ?? null, data.city)) {
      for (const { variantId } of variants) await this.recompute(tx, variantId, city);
    }
    return true;
  }

  /* ------------------------------------------------------- stock writes */

  /** Set what one nursery holds of one variant. */
  async setStock(nurseryId: string, variantId: string, update: StockUpdate): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO inventory (id, "nurseryId", "variantId", stock, reserved, condition, "isActive", "updatedAt")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::int, $4::int, $5::"OfferCondition", $6::boolean, now())
         ON CONFLICT ("nurseryId", "variantId") DO UPDATE
           SET stock = EXCLUDED.stock,
               reserved = COALESCE($7::int, inventory.reserved),
               condition = COALESCE($8::"OfferCondition", inventory.condition),
               "isActive" = COALESCE($9::boolean, inventory."isActive"),
               "updatedAt" = now()`,
        nurseryId,
        variantId,
        update.stock,
        update.reserved ?? 0,
        update.condition ?? "STANDARD",
        update.isActive ?? true,
        update.reserved ?? null,
        update.condition ?? null,
        update.isActive ?? null,
      );

      // Only where this nursery currently sells. A nursery we have not
      // heard about contributes nothing yet; its stock is counted the
      // moment its sellability event arrives (see applySellability).
      const [projection] = await tx.$queryRawUnsafe<{ city: string }[]>(
        `SELECT city FROM nursery_projection WHERE "nurseryId" = $1::uuid`,
        nurseryId,
      );
      if (projection) await this.recompute(tx, variantId, projection.city);
    });
  }

  /* ---------------------------------------------------------- recompute */

  /**
   * Recompute one (variant, city) total and announce it if it changed.
   * Safe to call at any time; idempotent.
   */
  async recompute(tx: SqlClient, variantId: string, city: string, force = false): Promise<boolean> {
    // Serialise per (variant, city). Without it, two transactions can each
    // read version N and both write N+1 with different totals; the lock
    // makes the second see the first's result.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `${variantId}|${city}`);

    const [computed] = await tx.$queryRawUnsafe<Totals[]>(
      `SELECT COALESCE(SUM(i.stock - i.reserved), 0)::int                    AS available,
              (COUNT(*) FILTER (WHERE i.stock - i.reserved > 0))::int        AS holders
         FROM inventory i
         JOIN nursery_projection p ON p."nurseryId" = i."nurseryId"
        WHERE i."variantId" = $1::uuid
          AND p.city = $2
          AND p.sellable
          AND i."isActive"`,
      variantId,
      city,
    );
    const [held] = await tx.$queryRawUnsafe<HeldAvailability[]>(
      `SELECT available, holders, version FROM availability WHERE "variantId" = $1::uuid AND city = $2`,
      variantId,
      city,
    );

    const next = decideAvailability(held ?? null, computed, force);
    if (!next) return false;

    await tx.$executeRawUnsafe(
      `INSERT INTO availability ("variantId", city, available, holders, version, "updatedAt")
       VALUES ($1::uuid, $2, $3::int, $4::int, $5::int, now())
       ON CONFLICT ("variantId", city) DO UPDATE
         SET available = EXCLUDED.available, holders = EXCLUDED.holders,
             version = EXCLUDED.version, "updatedAt" = now()`,
      variantId,
      city,
      next.available,
      next.holders,
      next.version,
    );
    await enqueueEvent(tx, PRODUCER, {
      type: EventTypes.InventoryAvailabilityChanged,
      data: { variantId, city, available: next.available, holders: next.holders, version: next.version },
    });
    return true;
  }

  /**
   * Recompute every pair this service knows about — those with stock in a
   * known city, plus those it has announced before (which may have dropped
   * to zero). With `force`, re-announce all of them under fresh versions,
   * to rebuild catalogue's projection.
   */
  async rebuildAll(force = false): Promise<{ pairs: number; announced: number }> {
    const pairs = await this.db.$queryRawUnsafe<{ variantId: string; city: string }[]>(
      `SELECT i."variantId", p.city
         FROM inventory i JOIN nursery_projection p ON p."nurseryId" = i."nurseryId"
       UNION
       SELECT "variantId", city FROM availability`,
    );
    let announced = 0;
    for (const { variantId, city } of pairs) {
      const changed = await this.db.transaction((tx) => this.recompute(tx, variantId, city, force));
      if (changed) announced++;
    }
    return { pairs: pairs.length, announced };
  }
}
