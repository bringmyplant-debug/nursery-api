import { statusFor } from "./upstream-errors";

describe("statusFor", () => {
  it("honours an explicit client or upstream status", () => {
    expect(statusFor({ statusCode: 404 })).toBe(404);
    expect(statusFor({ statusCode: 429 })).toBe(429);
  });

  it("reads a refused or reset connection as a bad gateway", () => {
    expect(statusFor(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(502);
    expect(statusFor(Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }))).toBe(502);
  });

  it("reads a timeout as a gateway timeout", () => {
    expect(statusFor(Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" }))).toBe(504);
  });

  it("finds the code on a wrapped cause", () => {
    expect(statusFor(new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe(502);
  });

  it("falls back to 500 for anything it does not recognise", () => {
    expect(statusFor(new Error("boom"))).toBe(500);
    expect(statusFor(undefined)).toBe(500);
  });
});

describe("statusFor with the proxy library's wrapped errors", () => {
  it("looks through a generic 500 wrapper to the connection error beneath", () => {
    const wrapped = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      statusCode: 500,
      code: "FST_REPLY_FROM_INTERNAL_SERVER_ERROR",
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(statusFor(wrapped)).toBe(502);
  });

  it("still reports a genuine 500 as 500", () => {
    expect(statusFor({ statusCode: 500, code: "FST_REPLY_FROM_INTERNAL_SERVER_ERROR" })).toBe(500);
  });
});
