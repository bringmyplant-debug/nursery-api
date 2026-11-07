import type { AvailabilityChangedData } from "@nursery-co/contracts";
import type { SqlClient } from "@nursery-co/platform";

/**
 * Whether an incoming announcement should replace the row held.
 *
 * Strictly newer only. Equal is a redelivery already applied; lower is a
 * late straggler that would put an old quantity back over a newer one.
 * Dropping both is what makes the projection correct under redelivery and
 * reordering without any ordering guarantee from the bus.
 */
export const isNewer = (heldVersion: number | null, incomingVersion: number): boolean =>
  heldVersion === null || incomingVersion > heldVersion;

/**
 * Fold one availability announcement into the projection.
 *
 * Runs inside the consumer's transaction. A single upsert guarded by the
 * version in its WHERE clause, not a read-then-write, so two replicas
 * applying the same pair concurrently cannot both pass the check and the
 * loser overwrite the winner.
 *
 * @returns whether the row changed
 */
export async function applyAvailability(tx: SqlClient, data: AvailabilityChangedData): Promise<boolean> {
  const changed = await tx.$executeRawUnsafe(
    `INSERT INTO variant_availability ("variantId", city, available, holders, version, "updatedAt")
     VALUES ($1::uuid, $2, $3::int, $4::int, $5::int, now())
     ON CONFLICT ("variantId", city) DO UPDATE
       SET available = EXCLUDED.available,
           holders = EXCLUDED.holders,
           version = EXCLUDED.version,
           "updatedAt" = now()
     WHERE variant_availability.version < EXCLUDED.version`,
    data.variantId,
    data.city,
    data.available,
    data.holders,
    data.version,
  );
  return changed > 0;
}
