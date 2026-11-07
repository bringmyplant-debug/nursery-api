import { CITY_MARKETS, cityPriceBps, cityPricePaise, retailRoundPaise } from "./city-pricing";
import { deriveVariantPrices, inchesOf, median, toRupee } from "./variant-pricing";

describe("median", () => {
  it("takes the middle of an odd set and the rounded mean of the middle pair of an even one", () => {
    expect(median([300, 100, 200])).toBe(200);
    expect(median([100, 200, 300, 450])).toBe(250);
  });

  it("is not dragged by an outlier", () => {
    expect(median([100, 110, 120, 9999])).toBe(115);
  });
});

describe("pot size helpers", () => {
  it("reads inches out of the label", () => {
    expect(inchesOf('12"')).toBe(12);
    expect(inchesOf("no digits")).toBe(0);
  });

  it("rounds paise to a whole hundred (rupee)", () => {
    expect(toRupee(43_749)).toBe(43_700);
  });
});

describe("deriveVariantPrices", () => {
  const offer = (plantSlug: string, potSize: string, pricePaise: number) => ({ plantSlug, potSize, pricePaise });

  it("uses the median across offers for each size", () => {
    const prices = deriveVariantPrices([
      offer("fern", '6"', 40_000),
      offer("fern", '6"', 50_000),
      offer("fern", '6"', 90_000),
    ]);
    expect(prices.get('fern::6"')).toBe(50_000);
  });

  it("lifts a larger size that did not clear the one below it, by 15%", () => {
    const prices = deriveVariantPrices([offer("fern", '6"', 100_000), offer("fern", '8"', 80_000)]);
    expect(prices.get('fern::6"')).toBe(100_000);
    expect(prices.get('fern::8"')).toBe(115_000);
  });

  it("leaves an already ascending ladder alone, whatever order the offers arrive in", () => {
    const prices = deriveVariantPrices([offer("fern", '10"', 90_000), offer("fern", '6"', 40_000), offer("fern", '8"', 60_000)]);
    expect([prices.get('fern::6"'), prices.get('fern::8"'), prices.get('fern::10"')]).toEqual([40_000, 60_000, 90_000]);
  });

  it("treats plants independently", () => {
    const prices = deriveVariantPrices([offer("a", '6"', 100_000), offer("b", '6"', 20_000)]);
    expect(prices.get('a::6"')).toBe(100_000);
    expect(prices.get('b::6"')).toBe(20_000);
  });
});

describe("city pricing", () => {
  const pune = CITY_MARKETS.find((m) => m.name === "Pune")!;
  const mumbai = CITY_MARKETS.find((m) => m.name === "Mumbai")!;

  it("Pune is the baseline: no change for a temperate-climate plant", () => {
    expect(cityPriceBps(pune, "moderate")).toBe(10_000);
  });

  it("prices end in 99 and never fall below the floor", () => {
    expect(retailRoundPaise(57_984) % 1_000).toBe(900);
    expect(retailRoundPaise(100)).toBe(4_900);
  });

  it("a dearer city costs more for the same plant", () => {
    expect(cityPricePaise(50_000, mumbai, "moderate")).toBeGreaterThan(cityPricePaise(50_000, pune, "moderate"));
  });

  it("a thirsty plant is cheaper to hold in humid Mumbai than a succulent is", () => {
    expect(cityPriceBps(mumbai, "high")).toBeLessThan(cityPriceBps(mumbai, "low"));
  });
});
