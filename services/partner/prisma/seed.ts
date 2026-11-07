/**
 * Seeds the partner database from the shared fixtures.
 *
 * Idempotent: ids are deterministic (UUIDv5 of kind + slug), so a second
 * run updates in place, and — the part that matters — the inventory
 * service, seeded from the same fixtures in a different database, derives
 * the *same* nursery ids without ever asking this one.
 *
 * Finishes by running the real sellability reconcile, so the announcements
 * a running service would make are queued in the outbox; the service's
 * relay publishes them once it is up.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPgAdapter, deterministicId, nurseryIdFor, toDatabase } from "@nursery-co/platform";
import { PrismaClient, type Prisma } from "../src/generated/prisma";
import { SellabilityEngine } from "../src/sellability/sellability.engine";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "seed-data", `${name}.json`), "utf8")) as T;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: createPgAdapter(url, 4) });

  try {
    const plans = read<Json[]>("plans");
    for (const p of plans) {
      const data = { ...p, id: deterministicId("plan", p.tier) } as Prisma.PlanUncheckedCreateInput;
      await prisma.plan.upsert({ where: { tier: p.tier }, update: data, create: data });
    }
    console.log(`  plans: ${plans.length}`);

    const planIds = new Map((await prisma.plan.findMany({ select: { id: true, tier: true } })).map((p) => [p.tier, p.id]));

    const nurseries = read<Json[]>("nurseries");
    for (const n of nurseries) {
      const { images, subscription, ...fields } = n;
      const id = nurseryIdFor(n.slug);
      const data = { ...fields, id, verifiedAt: n.verified ? new Date() : null } as Prisma.NurseryUncheckedCreateInput;
      await prisma.nursery.upsert({ where: { slug: n.slug }, update: data, create: data });

      await prisma.nurseryImage.deleteMany({ where: { nurseryId: id } });
      await prisma.nurseryImage.createMany({
        data: (images as Json[]).map((img, i) => ({
          ...img,
          id: deterministicId("nursery-image", `${n.slug}:${i}`),
          nurseryId: id,
        })) as Prisma.NurseryImageCreateManyInput[],
      });

      const planId = planIds.get(subscription.planTier);
      if (!planId) throw new Error(`Unknown plan tier "${subscription.planTier}" on ${n.slug}`);
      const subId = deterministicId("subscription", n.slug);
      const periodEnd = new Date(subscription.currentPeriodEnd);
      const subData = {
        id: subId,
        nurseryId: id,
        planId,
        status: subscription.status,
        currentPeriodEnd: periodEnd,
        trialEndsAt: subscription.status === "TRIALING" ? periodEnd : null,
      } as Prisma.SubscriptionUncheckedCreateInput;
      await prisma.subscription.upsert({ where: { id: subId }, update: subData, create: subData });
    }
    console.log(`  nurseries: ${nurseries.length} (+ images, subscriptions)`);

    const announced = await new SellabilityEngine(toDatabase(prisma)).reconcileDrifted();
    console.log(`  sellability: ${announced} announcement(s) queued in the outbox`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
