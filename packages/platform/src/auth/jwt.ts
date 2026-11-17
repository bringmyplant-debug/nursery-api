import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";

export const TOKEN_ISSUER = "nursery-identity";
/** Audience of an access token: what every service accepts on a protected route. */
export const ACCESS_AUDIENCE = "nursery-api";

/**
 * Only ES256. Naming the algorithm on every verify is what defeats the two
 * classic JWT attacks: `alg: none`, and presenting an HS256 token signed
 * with the (public!) verification key as if it were a shared secret.
 */
const ALGORITHM = "ES256" as const;

export type UserRole = "BUYER" | "ADMIN";
const ROLES: readonly UserRole[] = ["BUYER", "ADMIN"];

export interface AccessClaims {
  /** User id. */
  sub: string;
  role: UserRole;
  /** Session (refresh-token family) id, so logout can be tied to a token. */
  sid: string;
}

export class TokenError extends Error {
  constructor(message = "invalid token") {
    super(message);
    this.name = "TokenError";
  }
}

/**
 * Read a PEM key. The value is either a path to a PEM file (the normal
 * case; keeps multi-line keys out of environment variables) or the PEM
 * itself.
 */
export function loadPemKey(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is not configured`);
  const pem = value.includes("-----BEGIN") ? value.replace(/\\n/g, "\n") : readFileSync(value, "utf8");
  if (!pem.includes("-----BEGIN")) throw new Error(`${label} does not contain a PEM key`);
  return pem;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signAccessToken(privateKey: string, claims: AccessClaims, ttlSeconds: number): string {
  return jwt.sign({ role: claims.role, sid: claims.sid }, privateKey, {
    algorithm: ALGORITHM,
    issuer: TOKEN_ISSUER,
    audience: ACCESS_AUDIENCE,
    subject: claims.sub,
    expiresIn: ttlSeconds,
  });
}

/** Verify an access token. Throws {@link TokenError} for any reason at all; callers must not distinguish. */
export function verifyAccessToken(publicKey: string, token: string): AccessClaims {
  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: [ALGORITHM],
      issuer: TOKEN_ISSUER,
      audience: ACCESS_AUDIENCE,
      clockTolerance: 5,
    });
    if (typeof decoded === "string") throw new TokenError();
    payload = decoded;
  } catch {
    throw new TokenError();
  }

  const { sub, role, sid } = payload as { sub?: unknown; role?: unknown; sid?: unknown };
  if (typeof sub !== "string" || !UUID.test(sub)) throw new TokenError();
  if (typeof role !== "string" || !ROLES.includes(role as UserRole)) throw new TokenError();
  if (typeof sid !== "string" || sid.length === 0) throw new TokenError();
  return { sub, role: role as UserRole, sid };
}

/**
 * A short-lived token for a specific, narrow purpose (for example "this
 * phone proved ownership and may now register"). It carries its own
 * audience, so it can never be accepted where an access token is expected.
 */
export function signScopedToken(
  privateKey: string,
  audience: string,
  payload: Record<string, string>,
  ttlSeconds: number,
): string {
  return jwt.sign(payload, privateKey, {
    algorithm: ALGORITHM,
    issuer: TOKEN_ISSUER,
    audience,
    expiresIn: ttlSeconds,
  });
}

export function verifyScopedToken<T extends Record<string, string>>(
  publicKey: string,
  audience: string,
  token: string,
): T {
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: [ALGORITHM],
      issuer: TOKEN_ISSUER,
      audience,
      clockTolerance: 5,
    });
    if (typeof decoded === "string") throw new TokenError();
    return decoded as unknown as T;
  } catch {
    throw new TokenError();
  }
}

/** Seconds until `token` expires, read without verifying; for cookie lifetimes only, never for trust. */
export function secondsUntilExpiry(token: string, now = Date.now()): number | null {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === "string" || typeof decoded.exp !== "number") return null;
  return Math.max(0, Math.floor(decoded.exp - now / 1000));
}
