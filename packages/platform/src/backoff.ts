/**
 * Exponential backoff with jitter, capped.
 *
 * Jitter is not decoration. A consumer that fails because a dependency is
 * down will have *every* queued message fail at once; without jitter they
 * all retry on the same tick and knock the dependency straight back over.
 */
export function retryDelayMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const { baseMs = 500, maxMs = 30_000, random = Math.random } = opts;
  const n = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(maxMs, baseMs * 2 ** (n - 1));
  // 50–100% of the ceiling: spread out, but never so small it hammers.
  return Math.round(ceiling * (0.5 + random() * 0.5));
}
