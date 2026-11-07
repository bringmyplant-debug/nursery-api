import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import proxy from "@fastify/http-proxy";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { GatewayEnv } from "./config";
import { aggregateHealth } from "./health";
import { type OpenApiDoc, mergeOpenApi } from "./openapi-merge";
import { requestIdFrom } from "./request-id";
import { statusFor } from "./upstream-errors";
import { PUBLIC_ROUTES, upstreamOf } from "./routes";

/** Headers a client must never be able to smuggle through to a service. */
const STRIPPED_REQUEST_HEADERS = ["x-internal-token"] as const;

const OPENAPI_TTL_MS = 30_000;

export async function buildApp(env: GatewayEnv, fetchImpl: typeof fetch = fetch): Promise<FastifyInstance> {
  const upstreams = upstreamOf(env);

  const app = Fastify({
    trustProxy: true,
    // We assign the id ourselves (below) so only a well-formed client value
    // is ever honoured.
    requestIdHeader: false,
    genReqId: (req) => requestIdFrom(req.headers["x-request-id"]),
    logger: env.NODE_ENV === "test" ? false : { level: "info" },
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    methods: ["GET", "HEAD", "OPTIONS"],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    // A probe must never be throttled into reporting the platform as down.
    allowList: (req) => req.url.startsWith("/health"),
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  /** One error shape for everything the gateway itself answers. */
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = statusFor(error);
    if (status >= 500) request.log.error({ err: error }, "request failed");
    const unreachable = status === 502 || status === 503 || status === 504;
    reply.code(status).send({
      statusCode: status,
      error: unreachable ? "Upstream unavailable" : (error.name ?? "Error"),
      // Never echo internals: an upstream's error text can carry hostnames or SQL.
      message: status >= 500 ? "The service is temporarily unavailable." : error.message,
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      statusCode: 404,
      error: "Not Found",
      message: `No route for ${request.method} ${request.url.split("?")[0]}`,
      requestId: request.id,
    });
  });

  for (const route of PUBLIC_ROUTES) {
    await app.register(proxy, {
      upstream: upstreams[route.service],
      prefix: route.prefix,
      rewritePrefix: route.prefix,
      httpMethods: [...route.methods],
      // OPTIONS is answered by the CORS plugin; proxying it would double-handle preflights.
      replyOptions: {
        rewriteRequestHeaders: (request, headers) => {
          const forwarded = { ...headers, "x-request-id": request.id };
          for (const name of STRIPPED_REQUEST_HEADERS) delete (forwarded as Record<string, unknown>)[name];
          return forwarded;
        },
      },
    });
  }

  app.get("/health", async (_request, reply) => {
    const health = await aggregateHealth(upstreams, 2_000, fetchImpl);
    return reply.code(health.status === "down" ? 503 : 200).send(health);
  });

  // Process liveness only: no dependencies, so an orchestrator restarts a
  // wedged gateway but never because a backend is having a bad day.
  app.get("/health/live", async () => ({ status: "ok" }));

  let cached: { at: number; body: unknown } | undefined;
  app.get("/docs/openapi.json", async () => {
    if (cached && Date.now() - cached.at < OPENAPI_TTL_MS) return cached.body;

    const results = await Promise.all(
      Object.entries(upstreams).map(async ([service, base]) => {
        try {
          const res = await fetchImpl(new URL("/docs/openapi.json", base), { signal: AbortSignal.timeout(3_000) });
          return res.ok ? { service, doc: (await res.json()) as OpenApiDoc } : null;
        } catch {
          return null;
        }
      }),
    );

    const answered = results.filter((r): r is NonNullable<typeof r> => r !== null);
    const { document, warnings } = mergeOpenApi(answered);
    for (const w of warnings) app.log.warn(w);

    const body = {
      ...document,
      // Tell the reader when the picture is partial instead of presenting
      // a smaller API as though that were all there is.
      "x-unavailable-services": Object.keys(upstreams).filter((s) => !answered.some((a) => a.service === s)),
      "x-merge-warnings": warnings,
    };
    // Only cache a complete picture; a partial one should heal on the next request.
    if (answered.length === Object.keys(upstreams).length) cached = { at: Date.now(), body };
    return body;
  });

  return app;
}
