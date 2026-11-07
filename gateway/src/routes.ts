import type { GatewayEnv } from "./config";

export type ServiceName = "partner" | "inventory" | "catalogue";

export interface PublicRoute {
  /** Exact path prefix. Matches the prefix itself and anything beneath it. */
  prefix: string;
  service: ServiceName;
  /** Methods the public may use. Anything else is not routed. */
  methods: readonly ("GET" | "HEAD")[];
}

/**
 * The entire public surface of the platform.
 *
 * An allow-list, not a pass-through: a path is reachable from outside only
 * if it is written here. A new endpoint on a service is therefore private
 * by default, and the gateway has to be changed deliberately to expose it.
 * `/internal/*` is not listed and so cannot be reached, however a service
 * names its routes; that guard is the first of two layers (the second is
 * the service's own token check).
 *
 * Read-only for now: every public route is GET/HEAD. Write routes join this
 * table when the identity service exists to authenticate them.
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { prefix: "/v1/plants", service: "catalogue", methods: ["GET", "HEAD"] },
  { prefix: "/v1/categories", service: "catalogue", methods: ["GET", "HEAD"] },
  { prefix: "/v1/collections", service: "catalogue", methods: ["GET", "HEAD"] },
  { prefix: "/v1/plans", service: "partner", methods: ["GET", "HEAD"] },
];

export const upstreamOf = (env: GatewayEnv): Record<ServiceName, string> => ({
  partner: env.PARTNER_URL,
  inventory: env.INVENTORY_URL,
  catalogue: env.CATALOGUE_URL,
});

/** Whether `path` falls under a public prefix. Used to filter the merged API description. */
export const isPublicPath = (path: string): boolean =>
  PUBLIC_ROUTES.some((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
