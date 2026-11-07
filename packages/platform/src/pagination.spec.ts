import { decodeCursor, encodeCursor, toPage } from "./pagination";

describe("cursors", () => {
  it("round-trips a payload", () => {
    expect(decodeCursor(encodeCursor({ k: 1, id: "a" }))).toEqual({ k: 1, id: "a" });
  });

  it("returns null for missing or malformed cursors instead of throwing", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("%%%not-base64-json")).toBeNull();
  });
});

describe("toPage", () => {
  const cursorOf = (n: number) => `c${n}`;

  it("reports hasMore and trims the probe row", () => {
    const page = toPage([1, 2, 3], 2, cursorOf);
    expect(page.data).toEqual([1, 2]);
    expect(page.meta).toEqual({ nextCursor: "c2", hasMore: true, count: 2 });
  });

  it("has no cursor on the last page", () => {
    expect(toPage([1, 2], 2, cursorOf).meta).toEqual({ nextCursor: null, hasMore: false, count: 2 });
  });

  it("handles an empty result", () => {
    expect(toPage([], 10, cursorOf).meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
  });
});
