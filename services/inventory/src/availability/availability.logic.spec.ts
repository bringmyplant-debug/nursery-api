import { affectedCities, decideAvailability, isNewerThanHeld } from "./availability.logic";

describe("isNewerThanHeld", () => {
  it("accepts anything when nothing is held", () => {
    expect(isNewerThanHeld(null, 1)).toBe(true);
  });

  it("accepts only strictly newer versions", () => {
    expect(isNewerThanHeld({ version: 3 }, 4)).toBe(true);
    expect(isNewerThanHeld({ version: 3 }, 3)).toBe(false); // redelivery
    expect(isNewerThanHeld({ version: 3 }, 2)).toBe(false); // late straggler
  });
});

describe("affectedCities", () => {
  it("is just the city when the nursery has not moved, or is new", () => {
    expect(affectedCities(null, "Pune")).toEqual(["Pune"]);
    expect(affectedCities({ city: "Pune" }, "Pune")).toEqual(["Pune"]);
  });

  it("includes the old city when the nursery moved, so it loses the stock", () => {
    expect(affectedCities({ city: "Pune" }, "Mumbai")).toEqual(["Mumbai", "Pune"]);
  });
});

describe("decideAvailability", () => {
  it("is silent about a pair that never had stock", () => {
    expect(decideAvailability(null, { available: 0, holders: 0 })).toBeNull();
  });

  it("announces the first stock at version 1", () => {
    expect(decideAvailability(null, { available: 5, holders: 2 })).toEqual({ available: 5, holders: 2, version: 1 });
  });

  it("is silent when nothing changed", () => {
    expect(decideAvailability({ available: 5, holders: 2, version: 3 }, { available: 5, holders: 2 })).toBeNull();
  });

  it("bumps the version by one when the quantity changes", () => {
    expect(decideAvailability({ available: 5, holders: 2, version: 3 }, { available: 4, holders: 2 })).toEqual({
      available: 4,
      holders: 2,
      version: 4,
    });
  });

  it("announces when holders changes even though the total did not", () => {
    expect(decideAvailability({ available: 5, holders: 2, version: 3 }, { available: 5, holders: 1 })).toMatchObject({
      version: 4,
    });
  });

  it("announces running out, so catalogue stops showing the variant in stock", () => {
    expect(decideAvailability({ available: 5, holders: 1, version: 1 }, { available: 0, holders: 0 })).toEqual({
      available: 0,
      holders: 0,
      version: 2,
    });
  });

  it("force re-announces unchanged totals with a new version", () => {
    expect(decideAvailability({ available: 5, holders: 2, version: 3 }, { available: 5, holders: 2 }, true)).toEqual({
      available: 5,
      holders: 2,
      version: 4,
    });
  });

  it("force announces a never-announced empty pair too", () => {
    expect(decideAvailability(null, { available: 0, holders: 0 }, true)).toEqual({
      available: 0,
      holders: 0,
      version: 1,
    });
  });
});
