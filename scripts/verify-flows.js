/**
 * Live flow checks across partner -> inventory -> catalogue, through the gateway.
 *
 * Lapses a nursery subscription two ways (an API write, and the end date
 * simply passing with no write at all) and times how long the storefront takes
 * to reflect each, then restores the data. Needs the stack up and seeded.
 * Mutates and then reverts one nursery's subscription; run against dev data only.
 *
 *   node scripts/verify-flows.js
 */
const { execFileSync } = require("child_process");

const TOKEN = process.env.INTERNAL_API_TOKEN ?? "dev-internal-token-change-me";
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4000";
const PARTNER = process.env.PARTNER_URL ?? "http://localhost:4101";
const SLUG = "green-canopy-nursery";
const PLANT = "monstera-deliciosa";
const CITY = "Pune";

const psql = (db, sql) =>
  execFileSync("docker", ["exec", "nursery-api-db", "psql", "-U", "postgres", "-d", db, "-Atc", sql], { encoding: "utf8" }).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stock() {
  const body = await (await fetch(`${GATEWAY}/v1/plants/${PLANT}?city=${CITY}`)).json();
  return body.variants.map((v) => `${v.potSize}:${v.totalStock}/${v.nurseryCount}`).join(" ");
}

async function until(label, predicate, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const v = await stock();
    if (predicate(v)) {
      console.log(`  ${label}: converged in ${Date.now() - start}ms -> ${v}`);
      return v;
    }
    if (Date.now() - start > timeoutMs) {
      console.log(`  ${label}: TIMED OUT after ${timeoutMs}ms, still ${v}`);
      return null;
    }
    await sleep(100);
  }
}

const internal = (method, path, body) =>
  fetch(`${PARTNER}${path}`, {
    method,
    headers: body ? { "x-internal-token": TOKEN, "content-type": "application/json" } : { "x-internal-token": TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  const subId = psql(
    "nursery_partner",
    `SELECT s.id FROM subscriptions s JOIN nurseries n ON n.id=s."nurseryId" WHERE n.slug='${SLUG}'`,
  );
  const before = await stock();
  console.log(`baseline: ${before}`);

  // --- A: lapse through the API
  console.log("A. cancel the subscription via the partner API");
  const patch = await internal("PATCH", `/internal/subscriptions/${subId}`, { status: "CANCELLED" });
  console.log(`  PATCH -> ${patch.status}, sellability: ${JSON.stringify(patch.body.sellability)}`);
  const lapsed = await until("catalogue reflects lapse", (v) => v !== before);

  console.log("   renew it");
  await internal("PATCH", `/internal/subscriptions/${subId}`, { status: "ACTIVE" });
  await until("catalogue restored", (v) => v === before);

  // --- B: lapse by the passage of time only (no API write at all)
  console.log("B. subscription end date passes (direct DB change, no event from any write)");
  psql("nursery_partner", `UPDATE subscriptions SET "currentPeriodEnd" = now() - interval '1 day' WHERE id='${subId}'`);
  const sweep = await internal("POST", "/internal/sellability/reconcile");
  console.log(`  sweep announced: ${JSON.stringify(sweep.body)}`);
  await until("catalogue reflects expiry", (v) => v !== before);

  console.log("   restore end date");
  psql("nursery_partner", `UPDATE subscriptions SET "currentPeriodEnd" = now() + interval '90 days' WHERE id='${subId}'`);
  await internal("POST", "/internal/sellability/reconcile");
  await until("catalogue restored", (v) => v === before);

  const versions = psql("nursery_partner", `SELECT version FROM nursery_sellability s JOIN nurseries n ON n.id=s."nurseryId" WHERE n.slug='${SLUG}'`);
  console.log(`partner sellability version for ${SLUG} is now ${versions}; it increases by 4 on every run of this script`);
  console.log(`dead letters: inventory=${psql("nursery_inventory", "select count(*) from dead_letters")} catalogue=${psql("nursery_catalogue", "select count(*) from dead_letters")}`);
})();
