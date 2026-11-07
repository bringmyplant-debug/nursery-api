import {
  EventTypes,
  isAvailabilityChanged,
  isEnvelope,
  isSellabilityChanged,
} from "./index";

const UUID = "2ed6657d-e927-568b-95e1-2665a8aea6a2";

describe("isSellabilityChanged", () => {
  const valid = {
    nurseryId: UUID,
    city: "Pune",
    sellable: true,
    reason: "initial",
    version: 1,
  };

  it("accepts a well-formed payload", () => {
    expect(isSellabilityChanged(valid)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "sellable"],
    ["an array", [valid]],
    ["a non-uuid nurseryId", { ...valid, nurseryId: "n-001" }],
    ["an empty city", { ...valid, city: "" }],
    ["a stringly-typed boolean", { ...valid, sellable: "true" }],
    ["version zero", { ...valid, version: 0 }],
    ["a fractional version", { ...valid, version: 1.5 }],
    ["a missing version", { ...valid, version: undefined }],
  ])("rejects %s", (_label, payload) => {
    expect(isSellabilityChanged(payload)).toBe(false);
  });
});

describe("isAvailabilityChanged", () => {
  const valid = { variantId: UUID, city: "Delhi NCR", available: 0, holders: 0, version: 3 };

  it("accepts zero stock — an empty shelf is a real answer, not an error", () => {
    expect(isAvailabilityChanged(valid)).toBe(true);
  });

  it.each([
    ["negative stock", { ...valid, available: -1 }],
    ["fractional stock", { ...valid, available: 2.5 }],
    ["a missing holders count", { ...valid, holders: undefined }],
    ["a non-uuid variantId", { ...valid, variantId: "v-monstera-0" }],
  ])("rejects %s", (_label, payload) => {
    expect(isAvailabilityChanged(payload)).toBe(false);
  });
});

describe("isEnvelope", () => {
  const valid = {
    id: UUID,
    type: EventTypes.InventoryAvailabilityChanged,
    occurredAt: "2026-11-07T18:00:00.000Z",
    producer: "inventory",
    data: {},
  };

  it("accepts a well-formed envelope", () => {
    expect(isEnvelope(valid)).toBe(true);
  });

  it("rejects an unparseable timestamp", () => {
    expect(isEnvelope({ ...valid, occurredAt: "yesterday-ish" })).toBe(false);
  });

  it("rejects an envelope with no data key at all", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest.data;
    expect(isEnvelope(rest)).toBe(false);
  });
});

describe("EventTypes", () => {
  it("keeps every type in the <producer>.<noun>.<verb>.v<major> shape the broker subjects rely on", () => {
    for (const type of Object.values(EventTypes)) {
      expect(type).toMatch(/^[a-z]+\.[a-z-]+\.[a-z-]+\.v\d+$/);
    }
  });
});
