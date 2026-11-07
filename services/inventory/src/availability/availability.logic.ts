/** A nursery's sellability as held here (a copy of the partner's announcement). */
export interface HeldProjection {
  city: string;
  sellable: boolean;
  version: number;
}

/**
 * Whether an incoming sellability event should be applied.
 *
 * Strictly newer only. Equal means a redelivery already applied; lower
 * means a late straggler that would undo a newer fact. Both are dropped,
 * which is what makes the stream safe against redelivery and reordering
 * without any ordering guarantee from the bus.
 */
export const isNewerThanHeld = (held: Pick<HeldProjection, "version"> | null, incomingVersion: number): boolean =>
  held === null || incomingVersion > held.version;

/**
 * The cities whose totals a sellability change can affect: the nursery's
 * new city, and — if it moved — its old one, which must lose the stock.
 */
export function affectedCities(held: Pick<HeldProjection, "city"> | null, incomingCity: string): string[] {
  return held && held.city !== incomingCity ? [incomingCity, held.city] : [incomingCity];
}

export interface Totals {
  available: number;
  holders: number;
}

export interface HeldAvailability extends Totals {
  version: number;
}

export interface AvailabilityUpdate extends Totals {
  version: number;
}

/**
 * Decide whether freshly computed totals need announcing.
 *
 * - Never announced and nothing to sell: silence. A consumer with no row
 *   already reads that as zero, so "0 available" would be noise for every
 *   (variant, city) pair that has simply never had stock.
 * - Unchanged: silence. Versions move only on a real change.
 * - `force` re-announces regardless, with a new version, to rebuild a
 *   downstream projection.
 */
export function decideAvailability(
  held: HeldAvailability | null,
  computed: Totals,
  force = false,
): AvailabilityUpdate | null {
  if (held === null) {
    if (computed.available === 0 && computed.holders === 0 && !force) return null;
    return { ...computed, version: 1 };
  }
  const unchanged = held.available === computed.available && held.holders === computed.holders;
  if (unchanged && !force) return null;
  return { ...computed, version: held.version + 1 };
}
