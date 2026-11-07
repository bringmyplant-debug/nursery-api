export type HealthStatus = "ok" | "degraded";

export interface HealthReport {
  service: string;
  status: HealthStatus;
  /** Each dependency, `up` or `down`. */
  checks: Record<string, "up" | "down">;
  uptimeSeconds: number;
  timestamp: string;
  /** Service-specific facts: backlog sizes, projection freshness. */
  details?: Record<string, unknown>;
}

export type Check = () => Promise<boolean>;

/**
 * Run dependency checks in parallel, each with its own timeout.
 *
 * The timeout matters more than it looks. A health endpoint that hangs
 * when the database hangs reports nothing at the moment it is most
 * needed, and an orchestrator probing it will conclude the whole process
 * is dead rather than that one dependency is.
 */
export async function runHealthChecks(
  service: string,
  checks: Record<string, Check>,
  details?: () => Promise<Record<string, unknown>>,
  timeoutMs = 2_000,
): Promise<HealthReport> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, "up" | "down"]> => {
      try {
        const ok = await withTimeout(check(), timeoutMs);
        return [name, ok ? "up" : "down"];
      } catch {
        return [name, "down"];
      }
    }),
  );

  const results = Object.fromEntries(entries);
  const allUp = Object.values(results).every((r) => r === "up");

  let extra: Record<string, unknown> | undefined;
  if (details) {
    try {
      extra = await withTimeout(details(), timeoutMs);
    } catch {
      extra = { detailsUnavailable: true };
    }
  }

  return {
    service,
    status: allUp ? "ok" : "degraded",
    checks: results,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    ...(extra ? { details: extra } : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
