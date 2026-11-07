import { createHash, randomUUID } from "node:crypto";

/**
 * RFC 4122 version-5 UUID: SHA-1 of a namespace plus a name.
 *
 * Hand-rolled rather than imported — it is ten lines, and the `uuid`
 * package would be a dependency of every service for the sake of them.
 */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error(`Invalid UUID namespace: ${namespace}`);

  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));

  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Fixed forever. Changing it changes every id derived below, which would
 * orphan every cross-service reference made with the old ones.
 */
export const SEED_NAMESPACE = "b3f1c0de-5eed-4a11-9a7e-6e7572657279";

/**
 * An id derived from what a thing *is* rather than generated at random.
 *
 * Used by the seed scripts and nowhere else. Every service owns its own
 * database, so the catalogue's seed and the inventory's seed run
 * separately and cannot ask each other what id a plant variant got. If
 * both derive `deterministicId("variant", sku)` they agree without
 * talking. Production rows keep their random `gen_random_uuid()` ids; the
 * real flows learn each other's ids from events and API responses.
 */
export function deterministicId(kind: string, key: string): string {
  return uuidV5(`${kind}:${key}`, SEED_NAMESPACE);
}

export const newEventId = (): string => randomUUID();

/**
 * The ids services must agree on without talking to each other.
 *
 * Seed data names nurseries by slug and variants by plant + pot size; the
 * partner, inventory and catalogue seeds each insert into their own
 * database. Deriving the id from the natural key — here, once, shared —
 * is what lets inventory reference a catalogue variant it has never
 * queried. Changing either function re-keys every seeded row.
 */
export const nurseryIdFor = (slug: string): string => deterministicId("nursery", slug);

export const variantIdFor = (plantSlug: string, potSize: string): string =>
  deterministicId("variant", `${plantSlug}::${potSize}`);
