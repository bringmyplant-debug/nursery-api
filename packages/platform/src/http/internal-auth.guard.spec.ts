import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { InternalAuthGuard, tokensMatch } from "./internal-auth.guard";

const contextWith = (headers: Record<string, unknown>): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;

const guardFor = (token: string | undefined) =>
  new InternalAuthGuard({ get: () => token } as unknown as ConfigService);

describe("InternalAuthGuard", () => {
  const secret = "s3cret-token-0123456789";

  it("admits the right token", () => {
    expect(guardFor(secret).canActivate(contextWith({ "x-internal-token": secret }))).toBe(true);
  });

  it.each([
    ["missing", {}],
    ["wrong", { "x-internal-token": "nope-nope-nope-nope" }],
    ["array-valued", { "x-internal-token": [secret, secret] }],
    ["empty", { "x-internal-token": "" }],
  ])("rejects a %s header", (_label, headers) => {
    expect(() => guardFor(secret).canActivate(contextWith(headers))).toThrow(UnauthorizedException);
  });

  it("fails closed when no token is configured", () => {
    expect(() => guardFor(undefined).canActivate(contextWith({ "x-internal-token": "anything" }))).toThrow(
      UnauthorizedException,
    );
    expect(() => guardFor("").canActivate(contextWith({ "x-internal-token": "" }))).toThrow(
      UnauthorizedException,
    );
  });
});

describe("tokensMatch", () => {
  it("compares different-length strings without throwing", () => {
    expect(tokensMatch("a", "a-much-longer-token")).toBe(false);
    expect(tokensMatch("same", "same")).toBe(true);
  });
});
