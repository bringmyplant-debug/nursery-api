import {
  challengeState,
  codeMatches,
  generateCode,
  hashCode,
  hourlyWaitSeconds,
  resendWaitSeconds,
} from "./otp.logic";

describe("generateCode", () => {
  it("is always exactly the requested number of digits, including leading zeros", () => {
    expect(generateCode(6, () => 42)).toBe("000042");
    expect(generateCode(6, () => 0)).toBe("000000");
    expect(generateCode(6, () => 999_999)).toBe("999999");
  });

  it("draws from the whole range", () => {
    let seenMax = 0;
    const draw = (max: number) => {
      seenMax = max;
      return 7;
    };
    generateCode(4, draw);
    expect(seenMax).toBe(10_000);
  });

  it("produces different codes from the real source", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode(6)));
    expect(codes.size).toBeGreaterThan(40);
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
  });
});

describe("hashCode / codeMatches", () => {
  const pepper = "p".repeat(40);

  it("accepts the right code and rejects a wrong one", () => {
    const stored = hashCode(pepper, "challenge-1", "123456");
    expect(codeMatches(stored, pepper, "challenge-1", "123456")).toBe(true);
    expect(codeMatches(stored, pepper, "challenge-1", "123457")).toBe(false);
  });

  it("never stores the code itself", () => {
    expect(hashCode(pepper, "c", "123456")).not.toContain("123456");
  });

  it("is useless without the pepper", () => {
    const stored = hashCode(pepper, "c", "123456");
    expect(codeMatches(stored, "q".repeat(40), "c", "123456")).toBe(false);
  });

  it("does not let a hash from one challenge validate against another", () => {
    const stored = hashCode(pepper, "challenge-1", "123456");
    expect(codeMatches(stored, pepper, "challenge-2", "123456")).toBe(false);
  });

  it("copes with a malformed stored hash instead of throwing", () => {
    expect(codeMatches("not-hex", pepper, "c", "123456")).toBe(false);
    expect(codeMatches("", pepper, "c", "123456")).toBe(false);
  });
});

describe("challengeState", () => {
  const now = new Date("2026-11-15T10:00:00Z");
  const base = { expiresAt: new Date("2026-11-15T10:05:00Z"), consumedAt: null, attempts: 0 };

  it("is usable while fresh, unused and under the attempt limit", () => {
    expect(challengeState(base, now, 5)).toBe("usable");
    expect(challengeState({ ...base, attempts: 4 }, now, 5)).toBe("usable");
  });

  it("locks once the guesses are used up", () => {
    expect(challengeState({ ...base, attempts: 5 }, now, 5)).toBe("locked");
  });

  it("expires exactly at the expiry instant", () => {
    expect(challengeState({ ...base, expiresAt: now }, now, 5)).toBe("expired");
  });

  it("reports a used code as consumed, whatever else is true", () => {
    expect(challengeState({ ...base, consumedAt: now, attempts: 9 }, now, 5)).toBe("consumed");
  });
});

describe("resendWaitSeconds", () => {
  const now = new Date("2026-11-15T10:00:30Z");

  it("is zero with no previous code", () => {
    expect(resendWaitSeconds(null, now, 30)).toBe(0);
  });

  it("counts down the cooldown, rounding up", () => {
    expect(resendWaitSeconds(new Date("2026-11-15T10:00:20Z"), now, 30)).toBe(20);
    expect(resendWaitSeconds(new Date("2026-11-15T10:00:00Z"), now, 30)).toBe(0);
  });
});

describe("hourlyWaitSeconds", () => {
  const now = new Date("2026-11-15T10:30:00Z");
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it("allows a request while under the cap", () => {
    expect(hourlyWaitSeconds([at(50), at(40)], now, 5)).toBe(0);
  });

  it("blocks at the cap until the earliest counted request ages out", () => {
    const recent = [at(50), at(40), at(30), at(20), at(10)]; // oldest first
    // Oldest was 50 minutes ago, so a slot frees in 10 minutes.
    expect(hourlyWaitSeconds(recent, now, 5)).toBe(600);
  });
});
