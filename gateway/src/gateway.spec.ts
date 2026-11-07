import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp } from "./app";
import { GatewayEnv } from "./config";
import { mergeOpenApi } from "./openapi-merge";
import { requestIdFrom } from "./request-id";
import { isPublicPath } from "./routes";

/** A stand-in service that echoes what it received. */
async function fakeService(name: string, extra?: (app: FastifyInstance) => void): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify();
  app.get("/health", async () => ({ service: name, status: "ok" }));
  app.get("/docs/openapi.json", async () => ({ openapi: "3.0.0", paths: {}, components: { schemas: {} } }));
  app.all("/*", async (req) => ({
    service: name,
    method: req.method,
    url: req.url,
    requestId: req.headers["x-request-id"] ?? null,
    internalToken: req.headers["x-internal-token"] ?? null,
  }));
  extra?.(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

const envFor = (urls: { partner: string; inventory: string; catalogue: string }): GatewayEnv =>
  Object.assign(new GatewayEnv(), {
    NODE_ENV: "test",
    PARTNER_URL: urls.partner,
    INVENTORY_URL: urls.inventory,
    CATALOGUE_URL: urls.catalogue,
  });

// A port nothing listens on, to stand in for a service that is down.
const DEAD = "http://127.0.0.1:1";

describe("gateway", () => {
  const upstreams: FastifyInstance[] = [];
  let catalogue: { app: FastifyInstance; url: string };
  let partner: { app: FastifyInstance; url: string };
  let gateway: FastifyInstance;

  beforeAll(async () => {
    catalogue = await fakeService("catalogue");
    partner = await fakeService("partner");
    upstreams.push(catalogue.app, partner.app);
    gateway = await buildApp(envFor({ partner: partner.url, inventory: DEAD, catalogue: catalogue.url }));
  });

  afterAll(async () => {
    await gateway.close();
    await Promise.all(upstreams.map((u) => u.close()));
  });

  describe("routing", () => {
    it("proxies a public path to the owning service, preserving path and query", async () => {
      const res = await gateway.inject({ url: "/v1/plants/monstera?city=Pune" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ service: "catalogue", url: "/v1/plants/monstera?city=Pune" });
    });

    it("sends each prefix to the right service", async () => {
      expect((await gateway.inject({ url: "/v1/plans" })).json()).toMatchObject({ service: "partner" });
      expect((await gateway.inject({ url: "/v1/categories" })).json()).toMatchObject({ service: "catalogue" });
    });

    it.each(["/internal/nurseries", "/internal/availability/rebuild", "/v1/internal/x", "/v1/unlisted", "/admin"])(
      "does not route %s",
      async (url) => {
        const res = await gateway.inject({ url });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
      },
    );

    it("does not confuse a longer path for a public prefix", async () => {
      expect((await gateway.inject({ url: "/v1/plantsX" })).statusCode).toBe(404);
    });

    it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("does not route %s on a read-only path", async (method) => {
      const res = await gateway.inject({ method, url: "/v1/plants", payload: {} });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("headers", () => {
    it("never forwards a client-supplied internal token", async () => {
      const res = await gateway.inject({ url: "/v1/plants", headers: { "x-internal-token": "guessed-secret-value" } });
      expect(res.json().internalToken).toBeNull();
    });

    it("assigns a request id, forwards it, and returns it", async () => {
      const res = await gateway.inject({ url: "/v1/plants" });
      const id = res.headers["x-request-id"];
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.json().requestId).toBe(id);
    });

    it("honours a well-formed client request id", async () => {
      const res = await gateway.inject({ url: "/v1/plants", headers: { "x-request-id": "client-trace-12345" } });
      expect(res.headers["x-request-id"]).toBe("client-trace-12345");
      expect(res.json().requestId).toBe("client-trace-12345");
    });

    it("replaces a malformed client request id instead of trusting it", async () => {
      const res = await gateway.inject({ url: "/v1/plants", headers: { "x-request-id": "x y;<script>" } });
      expect(res.headers["x-request-id"]).not.toBe("x y;<script>");
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("sets security headers", async () => {
      const res = await gateway.inject({ url: "/v1/plants" });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  describe("failure", () => {
    it("answers a service outage with a clean JSON error carrying the request id, and no internals", async () => {
      const down = await buildApp(envFor({ partner: DEAD, inventory: DEAD, catalogue: DEAD }));
      try {
        const res = await down.inject({ url: "/v1/plants", headers: { "x-request-id": "trace-down-0001" } });
        expect(res.statusCode).toBeGreaterThanOrEqual(502);
        expect(res.statusCode).toBeLessThanOrEqual(504);
        const body = res.json();
        expect(body.requestId).toBe("trace-down-0001");
        expect(body.message).toBe("The service is temporarily unavailable.");
        expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
      } finally {
        await down.close();
      }
    });
  });

  describe("health", () => {
    it("reports degraded, not down, when one service is unreachable", async () => {
      const res = await gateway.inject({ url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("degraded");
      expect(body.services.catalogue.state).toBe("up");
      expect(body.services.inventory.state).toBe("down");
    });

    it("reports down (503) only when nothing answers", async () => {
      const down = await buildApp(envFor({ partner: DEAD, inventory: DEAD, catalogue: DEAD }));
      try {
        const res = await down.inject({ url: "/health" });
        expect(res.statusCode).toBe(503);
        expect(res.json().status).toBe("down");
      } finally {
        await down.close();
      }
    });

    it("has a liveness probe that depends on nothing", async () => {
      const down = await buildApp(envFor({ partner: DEAD, inventory: DEAD, catalogue: DEAD }));
      try {
        expect((await down.inject({ url: "/health/live" })).statusCode).toBe(200);
      } finally {
        await down.close();
      }
    });
  });

  describe("openapi", () => {
    it("serves a merged document and names the services it could not reach", async () => {
      const res = await gateway.inject({ url: "/docs/openapi.json" });
      expect(res.statusCode).toBe(200);
      expect(res.json()["x-unavailable-services"]).toEqual(["inventory"]);
    });
  });
});

describe("requestIdFrom", () => {
  it.each(["short", "has space in it!", "a".repeat(65), "line\nbreak-injected"])("rejects %j", (bad) => {
    expect(requestIdFrom(bad)).not.toBe(bad);
  });

  it("accepts a conforming id and uses the first of several", () => {
    expect(requestIdFrom("abc-DEF_123.456")).toBe("abc-DEF_123.456");
    expect(requestIdFrom(["first-valid-id", "second-valid-id"])).toBe("first-valid-id");
  });

  it("generates one when absent", () => {
    expect(requestIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("isPublicPath", () => {
  it("matches the prefix and anything beneath it only", () => {
    expect(isPublicPath("/v1/plants")).toBe(true);
    expect(isPublicPath("/v1/plants/monstera")).toBe(true);
    expect(isPublicPath("/v1/plantsX")).toBe(false);
    expect(isPublicPath("/internal/stock")).toBe(false);
  });
});

describe("mergeOpenApi", () => {
  const doc = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) => ({
    openapi: "3.0.0",
    paths,
    components: { schemas },
  });

  it("keeps only public paths, so internal routes cannot leak into documentation", () => {
    const { document } = mergeOpenApi([
      { service: "catalogue", doc: doc({ "/v1/plants": {}, "/internal/projection/status": {} }) },
    ]);
    expect(Object.keys(document.paths ?? {})).toEqual(["/v1/plants"]);
  });

  it("combines paths from different services", () => {
    const { document, warnings } = mergeOpenApi([
      { service: "catalogue", doc: doc({ "/v1/plants": {} }) },
      { service: "partner", doc: doc({ "/v1/plans": {} }) },
    ]);
    expect(Object.keys(document.paths ?? {}).sort()).toEqual(["/v1/plans", "/v1/plants"]);
    expect(warnings).toEqual([]);
  });

  it("reports a path defined twice and keeps the first", () => {
    const { document, warnings } = mergeOpenApi([
      { service: "catalogue", doc: doc({ "/v1/plants": { get: "a" } }) },
      { service: "partner", doc: doc({ "/v1/plants": { get: "b" } }) },
    ]);
    expect((document.paths as Record<string, unknown>)["/v1/plants"]).toEqual({ get: "a" });
    expect(warnings).toHaveLength(1);
  });

  it("reports a schema name with two shapes, but not an identical duplicate", () => {
    const same = mergeOpenApi([
      { service: "a", doc: doc({}, { Page: { type: "object" } }) },
      { service: "b", doc: doc({}, { Page: { type: "object" } }) },
    ]);
    expect(same.warnings).toEqual([]);

    const clash = mergeOpenApi([
      { service: "a", doc: doc({}, { Page: { type: "object" } }) },
      { service: "b", doc: doc({}, { Page: { type: "array" } }) },
    ]);
    expect(clash.warnings).toHaveLength(1);
  });
});
