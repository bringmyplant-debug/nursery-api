import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * A uniformly random numeric code, zero-padded to `length`.
 *
 * `randomInt` is rejection-sampled, so there is no modulo bias; and it is
 * the OS CSPRNG, never `Math.random`, which is predictable.
 */
export function generateCode(length: number, rand: (max: number) => number = (max) => randomInt(0, max)): string {
  return rand(10 ** length).toString().padStart(length, "0");
}

/**
 * What is stored in place of the code: an HMAC keyed with a server secret
 * ("pepper") and bound to the challenge id.
 *
 * A plain hash of a six-digit code is brute-forced in milliseconds, so a
 * database leak would hand out every live code. With a secret key outside
 * the database the stored value is useless on its own. Binding the id stops
 * one challenge's hash being replayed against another.
 */
export function hashCode(pepper: string, challengeId: string, code: string): string {
  return createHmac("sha256", pepper).update(`${challengeId}:${code}`).digest("hex");
}

/** Constant-time comparison of a candidate code against the stored hash. */
export function codeMatches(storedHash: string, pepper: string, challengeId: string, candidate: string): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashCode(pepper, challengeId, candidate), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type ChallengeState = "usable" | "expired" | "consumed" | "locked";

export interface ChallengeFacts {
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
}

/**
 * Whether a challenge may still be guessed at. `locked` means its guesses
 * are used up: the owner must ask for a new code, so an attacker gets five
 * tries per code and not unlimited tries against one.
 */
export function challengeState(c: ChallengeFacts, now: Date, maxAttempts: number): ChallengeState {
  if (c.consumedAt) return "consumed";
  if (c.expiresAt.getTime() <= now.getTime()) return "expired";
  if (c.attempts >= maxAttempts) return "locked";
  return "usable";
}

/** Seconds left before another code may be requested, or 0. */
export function resendWaitSeconds(lastCreatedAt: Date | null, now: Date, cooldownSeconds: number): number {
  if (!lastCreatedAt) return 0;
  const elapsed = (now.getTime() - lastCreatedAt.getTime()) / 1000;
  return Math.max(0, Math.ceil(cooldownSeconds - elapsed));
}

/**
 * Seconds until the hourly allowance frees up a slot, or 0 if one is free.
 * `recentCreatedAt` is every challenge created in the last hour, oldest first.
 */
export function hourlyWaitSeconds(recentCreatedAt: Date[], now: Date, maxPerHour: number): number {
  if (recentCreatedAt.length < maxPerHour) return 0;
  // The slot that frees first is the one `maxPerHour` places from the end.
  const blocking = recentCreatedAt[recentCreatedAt.length - maxPerHour];
  return Math.max(1, Math.ceil((blocking.getTime() + 3_600_000 - now.getTime()) / 1000));
}
