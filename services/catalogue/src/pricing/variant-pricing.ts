/**
 * Deriving one admin price per (plant, pot size) from historical offers.
 *
 * The seed fixture still records what each nursery used to charge, because
 * that is the data we have. The shop no longer works that way: admin sets
 * one price per variant and nurseries only hold quantity. So the fixture is
 * folded exactly as the monolith's pivot migration folded the live table:
 * median per variant, then a ladder pass.
 */

export interface PricedOffer {
  plantSlug: string;
  potSize: string;
  pricePaise: number;
}

/**
 * Median, not mean: two premium studios drag the average upward, and a
 * seeded price should look like something a human would set.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export const inchesOf = (potSize: string): number => Number(potSize.replace(/[^0-9]/g, "")) || 0;

/** Indian retail prices end in round numbers; 437 rupees looks like a bug. */
export const toRupee = (paise: number): number => Math.round(paise / 100) * 100;

/**
 * One price per `${plantSlug}::${potSize}`.
 *
 * The median has no idea a 6" pot should cost less than an 8". Each size's
 * median is drawn from whichever nurseries happened to stock it, so a size
 * carried mostly by budget yards can land below the size beneath it, and a
 * catalogue where the bigger plant is cheaper reads as a pricing bug. So
 * medians set the level and this enforces the ladder: walking each plant
 * small to large, any size that fails to clear the one below it is lifted
 * by 15%, roughly what one pot size is worth across the fixture.
 */
export function deriveVariantPrices(offers: readonly PricedOffer[]): Map<string, number> {
  const groups = new Map<string, { plantSlug: string; potSize: string; prices: number[] }>();
  for (const o of offers) {
    const key = `${o.plantSlug}::${o.potSize}`;
    const group = groups.get(key) ?? { plantSlug: o.plantSlug, potSize: o.potSize, prices: [] };
    group.prices.push(o.pricePaise);
    groups.set(key, group);
  }

  const byPlant = new Map<string, typeof groups extends Map<string, infer G> ? G[] : never>();
  for (const g of groups.values()) {
    const list = byPlant.get(g.plantSlug) ?? [];
    list.push(g);
    byPlant.set(g.plantSlug, list);
  }

  const result = new Map<string, number>();
  for (const [plantSlug, sizes] of byPlant) {
    let floor = 0;
    for (const size of [...sizes].sort((a, b) => inchesOf(a.potSize) - inchesOf(b.potSize))) {
      const fromData = toRupee(median(size.prices));
      const price = fromData > floor ? fromData : toRupee(floor * 1.15);
      result.set(`${plantSlug}::${size.potSize}`, price);
      floor = price;
    }
  }
  return result;
}
