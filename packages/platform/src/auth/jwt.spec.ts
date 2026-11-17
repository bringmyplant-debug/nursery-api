import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "node:crypto";
import {
  ACCESS_AUDIENCE,
  TOKEN_ISSUER,
  TokenError,
  loadPemKey,
  secondsUntilExpiry,
  signAccessToken,
  signScopedToken,
  verifyAccessToken,
  verifyScopedToken,
} from "./jwt";

const pair = () =>
  generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

const keys = pair();
const other = pair();
const claims = { sub: "7c9e6679-7425-40de-944b-e07fc1f90ae7", role: "BUYER" as const, sid: "session-1" };

describe("access tokens", () => {
  it("round-trips the claims", () => {
    const token = signAccessToken(keys.privateKey, claims, 60);
    expect(verifyAccessToken(keys.publicKey, token)).toEqual(claims);
  });

  it("rejects an expired token", () => {
    const token = jwt.sign({ role: "BUYER", sid: "s" }, keys.privateKey, {
      algorithm: "ES256",
      issuer: TOKEN_ISSUER,
      audience: ACCESS_AUDIENCE,
      subject: claims.sub,
      expiresIn: -60,
    });
    expect(() => verifyAccessToken(keys.publicKey, token)).toThrow(TokenError);
  });

  it("rejects a token signed by a different key", () => {
    const token = signAccessToken(other.privateKey, claims, 60);
    expect(() => verifyAccessToken(keys.publicKey, token)).toThrow(TokenError);
  });

  it("rejects a tampered payload", () => {
    const [h, , s] = signAccessToken(keys.privateKey, claims, 60).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, role: "ADMIN", iss: TOKEN_ISSUER, aud: ACCESS_AUDIENCE, exp: 9999999999 })).toString("base64url");
    expect(() => verifyAccessToken(keys.publicKey, `${h}.${forged}.${s}`)).toThrow(TokenError);
  });

  it("rejects alg=none", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ ...claims, iss: TOKEN_ISSUER, aud: ACCESS_AUDIENCE, exp: 9999999999 }),
    ).toString("base64url");
    expect(() => verifyAccessToken(keys.publicKey, `${header}.${body}.`)).toThrow(TokenError);
  });

  it("rejects an HS256 token signed with the public key as if it were a shared secret", () => {
    const token = jwt.sign({ role: "ADMIN", sid: "s" }, keys.publicKey, {
      algorithm: "HS256",
      issuer: TOKEN_ISSUER,
      audience: ACCESS_AUDIENCE,
      subject: claims.sub,
      expiresIn: 60,
    });
    expect(() => verifyAccessToken(keys.publicKey, token)).toThrow(TokenError);
  });

  it("rejects the wrong issuer and the wrong audience", () => {
    const base = { algorithm: "ES256" as const, subject: claims.sub, expiresIn: 60 };
    const wrongIssuer = jwt.sign({ role: "BUYER", sid: "s" }, keys.privateKey, { ...base, issuer: "someone-else", audience: ACCESS_AUDIENCE });
    const wrongAudience = jwt.sign({ role: "BUYER", sid: "s" }, keys.privateKey, { ...base, issuer: TOKEN_ISSUER, audience: "other" });
    expect(() => verifyAccessToken(keys.publicKey, wrongIssuer)).toThrow(TokenError);
    expect(() => verifyAccessToken(keys.publicKey, wrongAudience)).toThrow(TokenError);
  });

  it.each([
    ["a non-uuid subject", { sub: "not-a-uuid", role: "BUYER", sid: "s" }],
    ["an unknown role", { sub: claims.sub, role: "SUPERUSER", sid: "s" }],
    ["a missing session id", { sub: claims.sub, role: "BUYER" }],
  ])("rejects %s even when correctly signed", (_label, payload) => {
    const { sub, ...rest } = payload as Record<string, string>;
    const token = jwt.sign(rest, keys.privateKey, {
      algorithm: "ES256",
      issuer: TOKEN_ISSUER,
      audience: ACCESS_AUDIENCE,
      subject: sub,
      expiresIn: 60,
    });
    expect(() => verifyAccessToken(keys.publicKey, token)).toThrow(TokenError);
  });

  it("rejects garbage without leaking why", () => {
    expect(() => verifyAccessToken(keys.publicKey, "not.a.jwt")).toThrow(TokenError);
    expect(() => verifyAccessToken(keys.publicKey, "")).toThrow(TokenError);
  });
});

describe("scoped tokens", () => {
  it("round-trip within their own audience", () => {
    const token = signScopedToken(keys.privateKey, "signup", { phone: "+919876543210" }, 60);
    expect(verifyScopedToken<{ phone: string }>(keys.publicKey, "signup", token).phone).toBe("+919876543210");
  });

  it("are not accepted as access tokens, and access tokens are not accepted as scoped", () => {
    const scoped = signScopedToken(keys.privateKey, "signup", { phone: "+919876543210" }, 60);
    expect(() => verifyAccessToken(keys.publicKey, scoped)).toThrow(TokenError);

    const access = signAccessToken(keys.privateKey, claims, 60);
    expect(() => verifyScopedToken(keys.publicKey, "signup", access)).toThrow(TokenError);
  });

  it("expire", () => {
    const token = signScopedToken(keys.privateKey, "signup", { phone: "x" }, -60);
    expect(() => verifyScopedToken(keys.publicKey, "signup", token)).toThrow(TokenError);
  });
});

describe("loadPemKey", () => {
  it("accepts an inline PEM, including one with escaped newlines", () => {
    expect(loadPemKey(keys.publicKey, "k")).toContain("BEGIN PUBLIC KEY");
    expect(loadPemKey(keys.publicKey.replace(/\n/g, "\\n"), "k")).toContain("BEGIN PUBLIC KEY");
  });

  it("fails loudly when unset, so a service never boots without a key", () => {
    expect(() => loadPemKey(undefined, "JWT_PUBLIC_KEY_PATH")).toThrow(/not configured/);
  });
});

describe("secondsUntilExpiry", () => {
  it("reads the remaining lifetime without verifying", () => {
    const token = signAccessToken(keys.privateKey, claims, 900);
    expect(secondsUntilExpiry(token)).toBeGreaterThan(890);
    expect(secondsUntilExpiry(token)).toBeLessThanOrEqual(900);
  });

  it("is null for something that is not a token", () => {
    expect(secondsUntilExpiry("nope")).toBeNull();
  });
});
