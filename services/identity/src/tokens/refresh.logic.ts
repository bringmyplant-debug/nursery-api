export type RefreshVerdict =
  /** Live and never used: may be exchanged. */
  | "valid"
  | "unknown"
  | "expired"
  /** Its session was ended (sign-out, or revoked after theft). */
  | "revoked"
  /** Already exchanged a moment ago: almost certainly two requests racing, not theft. */
  | "in-flight"
  /** Already exchanged, and not recently: someone else holds a copy. Revoke the session. */
  | "reuse";

export interface RefreshFacts {
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Decide what presenting a refresh token means.
 *
 * Rotation makes every token single-use, which turns theft into something
 * detectable: the legitimate owner and the thief both hold the same token,
 * and whoever presents it second presents an already-used one. That is
 * `reuse`, and the response is to end the whole session.
 *
 * The complication is that a browser can legitimately send two requests at
 * once, both carrying the same token. The second one looks exactly like
 * reuse. A short grace window separates the two: a token used a few seconds
 * ago is `in-flight` (refuse it, but do not punish the session), one used
 * long ago is `reuse`.
 */
export function classifyRefresh(token: RefreshFacts | null, now: Date, graceSeconds: number): RefreshVerdict {
  if (!token) return "unknown";
  if (token.revokedAt) return "revoked";
  if (token.expiresAt.getTime() <= now.getTime()) return "expired";
  if (token.rotatedAt) {
    return now.getTime() - token.rotatedAt.getTime() <= graceSeconds * 1000 ? "in-flight" : "reuse";
  }
  return "valid";
}
