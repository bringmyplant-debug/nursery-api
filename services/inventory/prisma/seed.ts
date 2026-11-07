/**
 * Seeds the inventory database from the shared offers fixture.
 *
 * Each fixture row is one nursery's stock of one plant in one pot size. The
 * nursery and variant ids are derived from those natural keys with the
 * same functions the partner and catalogue seeds use, so this database
 * can reference rows it cannot see.
 *
 * Writes stock only. Whether a nursery is *currently sellable* is not
 * known here until the partner service's announcements arrive over the
 * bus; the running service folds the stock in as they do.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPgAdapter, nurseryIdFor, toDatabase, variantIdFor } from "@nursery-co/platform";
import { AvailabilityEngine } from "../src/availability/availability.engine";
import { PrismaClient } from "../src/generated/prisma";

interface Offer {
  plantSlug: string;
  nurserySlug: string;
  potSize: string;
  stock: number;
  condition: "PREMIUM" | "STANDARD" | "NURSERY_FRESH";
  updatedAt: string;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: createPgAdapter(url, 4) });

  try {
    const offers = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "..", "seed-data", "offers.json"), "utf8"),
    ) as Offer[];

    // Several offers can name the same (nursery, plant, pot size); the last wins, as in the monolith.
    const rows = new Map<string, Offer>();
    for (const o of offers) rows.set(`${o.nurserySlug}|${o.plantSlug}|${o.potSize}`, o);

    for (const o of rows.values()) {
      const data = {
        nurseryId: nurseryIdFor(o.nurserySlug),
        variantId: variantIdFor(o.plantSlug, o.potSize),
        stock: o.stock,
        reserved: 0,
        condition: o.condition,
        isActive: true,
        updatedAt: new Date(o.updatedAt),
      };
      await prisma.inventory.upsert({
        where: { nurseryId_variantId: { nurseryId: data.nurseryId, variantId: data.variantId } },
        update: data,
        create: data,
      });
    }
    console.log(`  inventory: ${rows.size} stock rows`);

    // Folds in whatever sellability has already been received. On a first
    // run there is none, so this is a no-op until the bus delivers it.
    const { pairs, announced } = await new AvailabilityEngine(toDatabase(prisma)).rebuildAll();
    console.log(`  availability: ${pairs} (variant, city) pairs checked, ${announced} announced`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
