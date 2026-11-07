import type { ServiceName } from "./routes";

export type ServiceState = "up" | "degraded" | "down";

export interface GatewayHealth {
  service: "gateway";
  status: "ok" | "degraded" | "down";
  services: Record<string, { state: ServiceState; report?: unknown }>;
  timestamp: string;
}

/**
 * Ask every service how it is, in parallel, each with its own timeout.
 *
 * `degraded` means reachable but reporting a failing dependency (a service
 * that has lost its message bus still serves reads); `down` means no
 * answer. The gateway as a whole is `down` only when nothing answers: one
 * sick service must not make the load balancer pull the whole front door.
 */
export async function aggregateHealth(
  upstreams: Record<ServiceName, string>,
  timeoutMs = 2_000,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayHealth> {
  const entries = await Promise.all(
    Object.entries(upstreams).map(async ([name, base]): Promise<[string, GatewayHealth["services"][string]]> => {
      try {
        const res = await fetchImpl(new URL("/health", base), { signal: AbortSignal.timeout(timeoutMs) });
        const report = (await res.json()) as { status?: string };
        const state: ServiceState = res.ok && report.status === "ok" ? "up" : "degraded";
        return [name, { state, report }];
      } catch {
        return [name, { state: "down" }];
      }
    }),
  );

  const services = Object.fromEntries(entries);
  const states = Object.values(services).map((s) => s.state);
  const status = states.every((s) => s === "up") ? "ok" : states.every((s) => s === "down") ? "down" : "degraded";

  return { service: "gateway", status, services, timestamp: new Date().toISOString() };
}
