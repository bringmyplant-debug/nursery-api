/**
 * Independent parity check.
 *
 * Recomputes what the storefront should show for every (plant, pot size, city)
 * straight from the raw fixtures, without using any service code, and compares
 * it with what the running stack reports through the gateway. Needs the stack
 * up and seeded (see README).
 *
 *   node scripts/verify-parity.js
 */
const fs = require("fs");
const path = require("path");

const SEED = path.join(__dirname, "..", "seed-data");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4000";
const read = (n) => JSON.parse(fs.readFileSync(path.join(SEED, n + ".json"), "utf8"));

const nurseries = read("nurseries");
const offers = read("offers");
const now = Date.now();

const byNursery = new Map(nurseries.map((n) => [n.slug, n]));
const sellable = (n) =>
  n.status === "ACTIVE" &&
  ["ACTIVE", "TRIALING"].includes(n.subscription.status) &&
  new Date(n.subscription.currentPeriodEnd).getTime() > now;

// last offer wins per (nursery, plant, pot)
const rows = new Map();
for (const o of offers) rows.set(`${o.nurserySlug}|${o.plantSlug}|${o.potSize}`, o);

const expected = new Map(); // `${plant}|${pot}|${city}` -> {stock, holders}
for (const o of rows.values()) {
  const n = byNursery.get(o.nurserySlug);
  if (!n || !sellable(n) || o.stock <= 0) continue;
  const key = `${o.plantSlug}|${o.potSize}|${n.city}`;
  const e = expected.get(key) ?? { stock: 0, holders: 0 };
  e.stock += o.stock;
  e.holders += 1;
  expected.set(key, e);
}

const cities = [...new Set(nurseries.map((n) => n.city))];
const plantSlugs = [...new Set(offers.map((o) => o.plantSlug))];

(async () => {
  let checked = 0;
  const mismatches = [];
  for (const slug of plantSlugs) {
    for (const city of cities) {
      const res = await fetch(`${GATEWAY}/v1/plants/${slug}?city=${encodeURIComponent(city)}`);
      if (!res.ok) {
        mismatches.push(`${slug}/${city}: HTTP ${res.status}`);
        continue;
      }
      const body = await res.json();
      for (const v of body.variants) {
        const e = expected.get(`${slug}|${v.potSize}|${city}`) ?? { stock: 0, holders: 0 };
        checked++;
        if (v.totalStock !== e.stock || v.nurseryCount !== e.holders) {
          mismatches.push(
            `${slug} ${v.potSize} @ ${city}: api stock=${v.totalStock}/holders=${v.nurseryCount}, expected ${e.stock}/${e.holders}`,
          );
        }
      }
    }
  }
  const totalExpected = [...expected.values()].reduce((s, e) => s + e.stock, 0);
  console.log(`variant-city pairs checked: ${checked}`);
  console.log(`expected total sellable units: ${totalExpected}; sellable nurseries: ${nurseries.filter(sellable).length}/${nurseries.length}`);
  console.log(mismatches.length ? `MISMATCHES (${mismatches.length}):\n` + mismatches.slice(0, 20).join("\n") : "PARITY OK: no mismatches");
  process.exit(mismatches.length ? 1 : 0);
})();
