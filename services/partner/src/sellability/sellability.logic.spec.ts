import { type Observation, decideTransition, isSellable, republishTransition } from "./sellability.logic";

const obs = (over: Partial<Observation> = {}): Observation => ({
  nurseryId: "n1",
  city: "Pune",
  active: true,
  liveSubscription: true,
  ...over,
});

describe("isSellable", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])("active=%s liveSubscription=%s -> %s", (active, liveSubscription, expected) => {
    expect(isSellable({ active, liveSubscription })).toBe(expected);
  });
});

describe("decideTransition", () => {
  it("announces a nursery seen for the first time, at version 1", () => {
    expect(decideTransition(null, obs())).toEqual({
      sellable: true,
      city: "Pune",
      version: 1,
      reason: "initial",
    });
  });

  it("announces a first-seen nursery that cannot sell too, so consumers hold an explicit false", () => {
    expect(decideTransition(null, obs({ liveSubscription: false }))).toMatchObject({
      sellable: false,
      version: 1,
    });
  });

  it("says nothing when nothing changed", () => {
    expect(decideTransition({ city: "Pune", sellable: true, version: 4 }, obs())).toBeNull();
  });

  it("bumps the version by exactly one on a change", () => {
    const t = decideTransition({ city: "Pune", sellable: true, version: 4 }, obs({ liveSubscription: false }));
    expect(t).toMatchObject({ sellable: false, version: 5, reason: "subscription-lapsed" });
  });

  it("reports renewal when it becomes sellable again", () => {
    const t = decideTransition({ city: "Pune", sellable: false, version: 2 }, obs());
    expect(t).toMatchObject({ sellable: true, version: 3, reason: "subscription-renewed" });
  });

  it("reports a status change when the nursery itself is no longer active", () => {
    const t = decideTransition({ city: "Pune", sellable: true, version: 1 }, obs({ active: false }));
    expect(t).toMatchObject({ sellable: false, reason: "status-changed" });
  });

  it("announces a move even though sellability is unchanged", () => {
    const t = decideTransition({ city: "Pune", sellable: true, version: 1 }, obs({ city: "Mumbai" }));
    expect(t).toEqual({ sellable: true, city: "Mumbai", version: 2, reason: "relocated" });
  });
});

describe("republishTransition", () => {
  it("always produces a newer version, even with no change", () => {
    expect(republishTransition({ city: "Pune", sellable: true, version: 7 }, obs())).toEqual({
      sellable: true,
      city: "Pune",
      version: 8,
      reason: "rebuild",
    });
  });

  it("starts at version 1 for a nursery never announced", () => {
    expect(republishTransition(null, obs()).version).toBe(1);
  });
});
