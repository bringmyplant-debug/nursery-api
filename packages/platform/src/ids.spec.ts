import { SEED_NAMESPACE, deterministicId, newEventId, nurseryIdFor, uuidV5, variantIdFor } from "./ids";

describe("uuidV5", () => {
  it("matches the RFC 4122 reference vector (python uuid5(NAMESPACE_DNS, 'python.org'))", () => {
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  it("is deterministic and sets version 5 / RFC variant bits", () => {
    const a = uuidV5("x", SEED_NAMESPACE);
    expect(a).toBe(uuidV5("x", SEED_NAMESPACE));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("deterministicId", () => {
  it("separates kinds so the same key never collides across entity types", () => {
    expect(deterministicId("plant", "rose")).not.toBe(deterministicId("category", "rose"));
  });

  it("is stable across calls", () => {
    expect(deterministicId("plant", "rose")).toBe(deterministicId("plant", "rose"));
  });
});

describe("newEventId", () => {
  it("returns distinct v4 uuids", () => {
    const a = newEventId();
    expect(a).not.toBe(newEventId());
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("shared natural-key ids", () => {
  it("nurseryIdFor is stable and distinct per slug", () => {
    expect(nurseryIdFor("a")).toBe(nurseryIdFor("a"));
    expect(nurseryIdFor("a")).not.toBe(nurseryIdFor("b"));
  });

  it("variantIdFor distinguishes plant and pot size, and does not collide with nursery ids", () => {
    expect(variantIdFor("monstera", '6"')).not.toBe(variantIdFor("monstera", '8"'));
    expect(variantIdFor("monstera", '6"')).not.toBe(nurseryIdFor("monstera::6\""));
  });
});
