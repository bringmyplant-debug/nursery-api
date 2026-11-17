import { classifyRefresh } from "./refresh.logic";

describe("classifyRefresh", () => {
  const now = new Date("2026-11-15T10:00:00Z");
  const future = new Date("2026-12-15T10:00:00Z");
  const live = { expiresAt: future, rotatedAt: null, revokedAt: null };
  const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

  it("is unknown for a token we have never issued", () => {
    expect(classifyRefresh(null, now, 10)).toBe("unknown");
  });

  it("accepts a live, unused token", () => {
    expect(classifyRefresh(live, now, 10)).toBe("valid");
  });

  it("rejects an expired token", () => {
    expect(classifyRefresh({ ...live, expiresAt: now }, now, 10)).toBe("expired");
  });

  it("rejects a revoked token", () => {
    expect(classifyRefresh({ ...live, revokedAt: secondsAgo(5) }, now, 10)).toBe("revoked");
  });

  it("treats a just-exchanged token as a concurrent request, not theft", () => {
    expect(classifyRefresh({ ...live, rotatedAt: secondsAgo(3) }, now, 10)).toBe("in-flight");
    expect(classifyRefresh({ ...live, rotatedAt: secondsAgo(10) }, now, 10)).toBe("in-flight");
  });

  it("treats an old already-exchanged token as theft", () => {
    expect(classifyRefresh({ ...live, rotatedAt: secondsAgo(11) }, now, 10)).toBe("reuse");
    expect(classifyRefresh({ ...live, rotatedAt: secondsAgo(86_400) }, now, 10)).toBe("reuse");
  });

  it("lets revocation win over everything else, so a killed session stays dead", () => {
    expect(classifyRefresh({ expiresAt: future, rotatedAt: secondsAgo(1), revokedAt: secondsAgo(1) }, now, 10)).toBe("revoked");
  });

  it("with no grace configured, any reuse is theft", () => {
    expect(classifyRefresh({ ...live, rotatedAt: secondsAgo(1) }, now, 0)).toBe("reuse");
  });
});
