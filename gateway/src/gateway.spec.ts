import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp, parseTrustProxy } from "./app";
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

// A port nothing listens on, to stand in for a service that is down.
const DEAD = "http://127.0.0.1:1";

const envFor = (
  urls: { partner: string; inventory: string; catalogue: string; identity?: string },
  overrides: Partial<GatewayEnv> = {},
): GatewayEnv =>
  Object.assign(new GatewayEnv(), {
    NODE_ENV: "test",
    PARTNER_URL: urls.partner,
    INVENTORY_URL: urls.inventory,
    CATALOGUE_URL: urls.catalogue,
    IDENTITY_URL: urls.identity ?? DEAD,
    ...overrides,
  });


describe("gateway", () => {
  const upstreams: FastifyInstance[] = [];
  let catalogue: { app: FastifyInstance; url: string };
  let partner: { app: FastifyInstance; url: string };
  let identity: { app: FastifyInstance; url: string };
  let gateway: FastifyInstance;

  beforeAll(async () => {
    catalogue = await fakeService("catalogue");
    partner = await fakeService("partner");
    identity = await fakeService("identity", (app) => {
      // Echo the body and the credentials the gateway forwarded.
      app.post("/v1/auth/otp/request", async (req) => ({ got: req.body, authorization: req.headers.authorization ?? null }));
      app.patch("/v1/auth/me", async (req) => ({ patched: req.body, authorization: req.headers.authorization ?? null }));
    });
    upstreams.push(catalogue.app, partner.app, identity.app);
    gateway = await buildApp(
      envFor({ partner: partner.url, inventory: DEAD, catalogue: catalogue.url, identity: identity.url }),
    );
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

  describe("auth routes", () => {
    it("passes a JSON body through to the identity service", async () => {
      const res = await gateway.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { phone: "9876543210" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().got).toEqual({ phone: "9876543210" });
    });

    it("forwards the bearer token, which is how services authenticate the caller", async () => {
      const res = await gateway.inject({
        method: "PATCH",
        url: "/v1/auth/me",
        headers: { authorization: "Bearer abc.def.ghi" },
        payload: { name: "Asha" },
      });
      expect(res.json()).toMatchObject({ patched: { name: "Asha" }, authorization: "Bearer abc.def.ghi" });
    });

    it("routes GET /v1/auth/* to identity", async () => {
      expect((await gateway.inject({ url: "/v1/auth/me" })).json()).toMatchObject({ service: "identity" });
    });

    it("accepts writes only where the table says so: /v1/auth yes, the catalogue and nurseries no", async () => {
      expect((await gateway.inject({ method: "POST", url: "/v1/nurseries/mine", payload: {} })).statusCode).toBe(404);
      expect((await gateway.inject({ method: "PATCH", url: "/v1/plants/x", payload: {} })).statusCode).toBe(404);
      expect((await gateway.inject({ method: "DELETE", url: "/v1/auth/me" })).statusCode).toBe(404);
    });

    it("does not expose the identity internals", async () => {
      expect((await gateway.inject({ url: "/internal/dev/otp/9876543210" })).statusCode).toBe(404);
    });

    it("keys the limit on the real client, and only believes X-Forwarded-For from a trusted peer", async () => {
      const app = await buildApp(
        envFor(
          { partner: partner.url, inventory: DEAD, catalogue: catalogue.url, identity: identity.url },
          { AUTH_RATE_LIMIT_PER_MINUTE: 2, TRUST_PROXY: "loopback" },
        ),
      );
      const hit = (remoteAddress: string, forwardedFor: string) =>
        app
          .inject({ method: "POST", url: "/v1/auth/otp/request", remoteAddress, headers: { "x-forwarded-for": forwardedFor }, payload: { phone: "9876543210" } })
          .then((r) => r.statusCode);
      try {
        // A trusted peer (the web server) forwards each user's address: separate users, separate buckets.
        expect(await hit("127.0.0.1", "203.0.113.1")).toBe(200);
        expect(await hit("127.0.0.1", "203.0.113.1")).toBe(200);
        expect(await hit("127.0.0.1", "203.0.113.1")).toBe(429);
        expect(await hit("127.0.0.1", "203.0.113.2")).toBe(200);

        // An untrusted peer cannot dodge the limit by inventing addresses.
        expect(await hit("198.51.100.9", "10.0.0.1")).toBe(200);
        expect(await hit("198.51.100.9", "10.0.0.2")).toBe(200);
        expect(await hit("198.51.100.9", "10.0.0.3")).toBe(429);
      } finally {
        await app.close();
      }
    });

    it("throttles /v1/auth on its own, much lower, limit without throttling the rest of the API", async () => {
      const limited = await buildApp(
        envFor(
          { partner: partner.url, inventory: DEAD, catalogue: catalogue.url, identity: identity.url },
          { AUTH_RATE_LIMIT_PER_MINUTE: 3, RATE_LIMIT_PER_MINUTE: 100 },
        ),
      );
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
          statuses.push((await limited.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { phone: "9876543210" } })).statusCode);
        }
        expect(statuses).toEqual([200, 200, 200, 429, 429]);

        // The general bucket is separate: browsing still works while auth is throttled.
        expect((await limited.inject({ url: "/v1/plants" })).statusCode).toBe(200);
        // And the 429 is in the gateway's own error shape, with a request id.
        const blocked = await limited.inject({ method: "POST", url: "/v1/auth/otp/request", payload: {} });
        expect(blocked.json()).toMatchObject({ statusCode: 429, requestId: expect.any(String) });
      } finally {
        await limited.close();
      }
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

describe("parseTrustProxy", () => {
  it("parses lists, and treats empty or false as trusting nobody", () => {
    expect(parseTrustProxy("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
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
