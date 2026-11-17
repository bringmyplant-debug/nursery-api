import { maskPhone, normalizeIndianMobile } from "./phone";

describe("normalizeIndianMobile", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["98765-43210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["+91-9876543210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["(+91) 6000000000", "+916000000000"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each([
    ["too short", "98765"],
    ["too long", "98765432101"],
    ["starts with 5 (not a mobile range)", "5876543210"],
    ["a landline-style number", "0201234567"],
    ["another country code", "+14155552671"],
    ["a UK number", "+447911123456"],
    ["letters", "98765abcde"],
    ["empty", ""],
    ["only a prefix", "+91"],
    ["sql-ish", "9876543210'; DROP"],
    ["whitespace only", "   "],
    ["absurdly long", "9".repeat(200)],
  ])("rejects %s", (_label, input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });

  it.each([null, undefined, 9876543210, {}, []])("rejects a non-string (%j)", (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });

  it("gives the same canonical form for every spelling of one number", () => {
    const forms = ["9876543210", "+91 98765 43210", "919876543210", "09876543210"].map(normalizeIndianMobile);
    expect(new Set(forms).size).toBe(1);
  });
});

describe("maskPhone", () => {
  it("hides the middle of the number", () => {
    const masked = maskPhone("+919876543210");
    expect(masked.startsWith("+91")).toBe(true);
    expect(masked.endsWith("210")).toBe(true);
    expect(masked).not.toContain("98765");
  });

  it("copes with something too short to mask meaningfully", () => {
    expect(maskPhone("+91")).toBe("•••");
  });
});
