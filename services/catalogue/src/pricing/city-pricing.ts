/**
 * What a city does to a price.
 *
 * Price stopped being a property of a SKU when it became clear the same
 * plant does not cost the same to keep alive everywhere: a fern wants
 * humidity it will not get through a Delhi April, and a succulent wants
 * dryness it will not get through a Mumbai July. One national price
 * would either underpay partners in the hard markets or overcharge
 * buyers in the easy ones.
 *
 * This module is the *derivation*, used to seed and to backfill
 * variant_city_prices. It is not consulted at request time — the
 * storefront reads the stored rows, so an admin who overrides one by
 * hand is not silently overruled by a formula on the next page load.
 *
 * Mirrors apps/web/src/lib/city.ts. The two must agree; the web copy is
 * the one a designer is likely to read, this one is the one that writes
 * the database.
 */

export type Climate = "arid" | "temperate" | "humid";

export interface CityMarket {
  name: string;
  /** Cost of operating here, against Pune as the baseline. Basis points. */
  overheadBps: number;
  climate: Climate;
  /** Stored on each row so an override is never unexplained. */
  note: string;
}

export const CITY_MARKETS: readonly CityMarket[] = [
  {
    name: "Pune",
    overheadBps: 10_000,
    climate: "temperate",
    note: "Baseline market",
  },
  {
    // Bench space in and around the city costs more than anywhere else
    // we operate, and that lands on every pot regardless of species.
    name: "Mumbai",
    overheadBps: 11_600,
    climate: "humid",
    note: "Highest bench rent, humid",
  },
  {
    name: "Bengaluru",
    overheadBps: 10_800,
    climate: "temperate",
    note: "Kind weather, dear land",
  },
  {
    name: "Delhi NCR",
    overheadBps: 10_400,
    climate: "arid",
    note: "Hard summers and hard winters",
  },
  {
    name: "Hyderabad",
    overheadBps: 10_000,
    climate: "arid",
    note: "Dry heat, low overheads",
  },
  {
    name: "Chennai",
    overheadBps: 10_600,
    climate: "humid",
    note: "Warm and humid year round",
  },
] as const;

/** Matches the WaterNeed enum, lowercased. */
export type WaterNeedKey = "low" | "moderate" | "high";

/**
 * How much harder this climate makes this plant.
 *
 * Read down a column rather than across: a succulent is cheap to hold in
 * Hyderabad and dear in Chennai, and a fern is the other way round. That
 * inversion is the whole reason this is a table and not one number per
 * city.
 *
 *   arid + thirsty     shade nets, misting lines, a water bill
 *   arid + succulent   thrives, almost nothing is lost
 *   humid + succulent  rot and fungus; covered benches, gritty mix, and
 *                      losses even so
 *   humid + thirsty    thrives
 */
const CLIMATE_BPS: Record<Climate, Record<WaterNeedKey, number>> = {
  arid: { low: 9_400, moderate: 10_500, high: 11_400 },
  temperate: { low: 10_000, moderate: 10_000, high: 10_000 },
  humid: { low: 11_200, moderate: 10_000, high: 9_500 },
};

export function cityPriceBps(market: CityMarket, water: WaterNeedKey): number {
  return Math.round(
    (market.overheadBps * CLIMATE_BPS[market.climate][water]) / 10_000,
  );
}

/**
 * Indian retail prices end in 9. Rounding to the rupee is not enough — a
 * multiplier applied to ₹499 gives ₹579.84, and ₹580 reads as a number a
 * spreadsheet produced rather than one a shop chose.
 */
export const retailRoundPaise = (paise: number): number =>
  Math.max(4_900, Math.round(paise / 1_000) * 1_000 - 100);

/** A national base price resolved into what one city pays. */
export function cityPricePaise(
  basePaise: number,
  market: CityMarket,
  water: WaterNeedKey,
): number {
  return retailRoundPaise((basePaise * cityPriceBps(market, water)) / 10_000);
}
