/**
 * Seeds the catalogue database from the shared fixtures.
 *
 * Idempotent: every write is an upsert on a natural key, and variant ids
 * are derived from (plant slug, pot size) with the same function the
 * inventory seed uses, so inventory can reference variants it cannot see.
 *
 * Stock is not seeded here. It reaches this database as availability
 * events from the inventory service, the same path it takes in production.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPgAdapter, deterministicId, variantIdFor } from "@nursery-co/platform";
import { Prisma, PrismaClient } from "../src/generated/prisma";
import { CITY_MARKETS, cityPricePaise, type WaterNeedKey } from "../src/pricing/city-pricing";
import { deriveVariantPrices, inchesOf, type PricedOffer } from "../src/pricing/variant-pricing";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "seed-data", `${name}.json`), "utf8")) as T;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: createPgAdapter(url, 4) });

  try {
    // --- categories -----------------------------------------------------
    const categories = read<Json[]>("categories");
    for (const c of categories) {
      const data = { id: deterministicId("category", c.slug), slug: c.slug, name: c.name, sortOrder: c.sortOrder };
      await prisma.category.upsert({
        where: { slug: c.slug },
        update: { name: c.name, sortOrder: c.sortOrder },
        create: data,
      });
    }
    console.log(`  categories: ${categories.length}`);

    // --- plants ---------------------------------------------------------
    const categoryIds = new Map(
      (await prisma.category.findMany({ select: { id: true, slug: true } })).map((c) => [c.slug, c.id]),
    );

    const plants = read<Json[]>("plants");
    for (const p of plants) {
      const { images, categorySlug, ...fields } = p;
      const categoryId = categoryIds.get(categorySlug);
      if (!categoryId) throw new Error(`Unknown category "${categorySlug}" on plant ${p.slug}`);

      const data = {
        ...fields,
        id: deterministicId("plant", p.slug),
        categoryId,
        publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
      };
      const plant = await prisma.plant.upsert({
        where: { slug: p.slug },
        update: data,
        create: data as Prisma.PlantUncheckedCreateInput,
      });

      // Images have no natural key, so replace the set rather than accumulate.
      await prisma.plantImage.deleteMany({ where: { plantId: plant.id } });
      await prisma.plantImage.createMany({
        data: (images as Json[]).map((img, i) => ({
          ...img,
          id: deterministicId("plant-image", `${p.slug}:${i}`),
          plantId: plant.id,
        })) as Prisma.PlantImageCreateManyInput[],
      });
    }
    console.log(`  plants: ${plants.length} (+ images)`);

    // --- variants ---------------------------------------------------------
    const plantIds = new Map((await prisma.plant.findMany({ select: { id: true, slug: true } })).map((p) => [p.slug, p.id]));

    const offers = read<(PricedOffer & Json)[]>("offers");
    const prices = deriveVariantPrices(offers);

    const sizes = new Map<string, { plantSlug: string; potSize: string; rows: Json[] }>();
    for (const o of offers) {
      const key = `${o.plantSlug}::${o.potSize}`;
      const group = sizes.get(key) ?? { plantSlug: o.plantSlug, potSize: o.potSize, rows: [] };
      group.rows.push(o);
      sizes.set(key, group);
    }

    let variantCount = 0;
    for (const { plantSlug, potSize, rows } of sizes.values()) {
      const plantId = plantIds.get(plantSlug);
      if (!plantId) continue;

      const inches = potSize.replace(/[^0-9]/g, "");
      const data = {
        id: variantIdFor(plantSlug, potSize),
        plantId,
        sku: `${plantSlug.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${inches}IN`,
        label: `${potSize} pot`,
        potSize,
        potMaterial: rows[0].potMaterial ?? null,
        heightCm: Math.round(rows.reduce((sum, r) => sum + (r.heightCm ?? 0), 0) / rows.length),
        basePricePaise: prices.get(`${plantSlug}::${potSize}`)!,
        // GST placeholder. Live plants (HSN 0602) and planters (HSN
        // 3924/6914) are rated differently and this has NOT been verified
        // against current notifications: confirm with an accountant before
        // taking real money. Stored per variant so correcting it is data,
        // not a deploy.
        taxRateBps: 500,
        sortOrder: inchesOf(potSize),
      };
      await prisma.plantVariant.upsert({
        where: { plantId_potSize: { plantId, potSize } },
        update: data,
        create: data as Prisma.PlantVariantUncheckedCreateInput,
      });
      variantCount++;
    }
    console.log(`  variants: ${variantCount}`);

    // --- city prices ------------------------------------------------------
    // One row per variant per market. Derived here, not at request time, so
    // an admin can override a single row by hand without a formula quietly
    // overruling them on the next page load.
    const waterByPlantId = new Map(
      (await prisma.plant.findMany({ select: { id: true, waterNeed: true } })).map((p) => [
        p.id,
        p.waterNeed.toLowerCase() as WaterNeedKey,
      ]),
    );
    const variants = await prisma.plantVariant.findMany({
      select: { id: true, plantId: true, basePricePaise: true, baseMrpPaise: true },
    });

    let cityPriceRows = 0;
    for (const variant of variants) {
      const water = waterByPlantId.get(variant.plantId) ?? "moderate";
      for (const market of CITY_MARKETS) {
        const data = {
          variantId: variant.id,
          city: market.name,
          pricePaise: cityPricePaise(variant.basePricePaise, market, water),
          mrpPaise: variant.baseMrpPaise ? cityPricePaise(variant.baseMrpPaise, market, water) : null,
          note: market.note,
        };
        await prisma.variantCityPrice.upsert({
          where: { variantId_city: { variantId: variant.id, city: market.name } },
          update: data,
          create: { ...data, id: deterministicId("city-price", `${variant.id}:${market.name}`) },
        });
        cityPriceRows++;
      }
    }
    console.log(`  city prices: ${cityPriceRows} (${CITY_MARKETS.length} cities)`);

    // --- collections ------------------------------------------------------
    const collections = read<Json[]>("collections");
    for (const c of collections) {
      const { plantSlugs, ...fields } = c;
      const data = { ...fields, id: deterministicId("collection", c.slug) };
      const collection = await prisma.collection.upsert({
        where: { slug: c.slug },
        update: fields,
        create: data as Prisma.CollectionUncheckedCreateInput,
      });

      await prisma.collectionPlant.deleteMany({ where: { collectionId: collection.id } });
      await prisma.collectionPlant.createMany({
        data: (plantSlugs as string[])
          .map((slug, i) => ({ collectionId: collection.id, plantId: plantIds.get(slug)!, sortOrder: i }))
          .filter((row) => Boolean(row.plantId)),
      });
    }
    console.log(`  collections: ${collections.length} (+ membership)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
