import { retryDelayMs } from "./backoff";

describe("retryDelayMs", () => {
  const low = () => 0;
  const high = () => 0.999999;

  it("grows exponentially and stays within 50-100% of the ceiling", () => {
    expect(retryDelayMs(1, { baseMs: 100, random: low })).toBe(50);
    expect(retryDelayMs(1, { baseMs: 100, random: high })).toBe(100);
    expect(retryDelayMs(4, { baseMs: 100, random: high })).toBe(800);
  });

  it("caps at maxMs", () => {
    expect(retryDelayMs(30, { baseMs: 100, maxMs: 1000, random: high })).toBe(1000);
    expect(retryDelayMs(30, { baseMs: 100, maxMs: 1000, random: low })).toBe(500);
  });

  it("treats attempt < 1 as the first attempt", () => {
    expect(retryDelayMs(0, { baseMs: 100, random: high })).toBe(100);
    expect(retryDelayMs(-5, { baseMs: 100, random: high })).toBe(100);
  });
});
