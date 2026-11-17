/**
 * Seeds development accounts.
 *
 * Idempotent, and ids come from `userIdFor(phone)` so the partner seed can
 * link the nursery owner to a nursery without asking this database. These
 * are well-formed but fictional numbers: with the console SMS provider no
 * message is ever sent, and the one-time code is printed in the identity
 * service's log.
 *
 * Refuses to run in production: seeded admins are a backdoor anywhere real.
 */
import "dotenv/config";
import { createPgAdapter, userIdFor } from "@nursery-co/platform";
import { PrismaClient, type UserRole } from "../src/generated/prisma";

const SEED_USERS: readonly { phone: string; name: string; role: UserRole; email: string }[] = [
  { phone: "+919000000001", name: "Platform Admin", role: "ADMIN", email: "admin@example.com" },
  { phone: "+919000000002", name: "Asha Demo", role: "BUYER", email: "asha@example.com" },
  { phone: "+919000000003", name: "Green Canopy Owner", role: "BUYER", email: "owner@green-canopy.example.com" },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed accounts in production.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const prisma = new PrismaClient({ adapter: createPgAdapter(url, 2) });
  try {
    const now = new Date();
    for (const u of SEED_USERS) {
      const data = { ...u, id: userIdFor(u.phone), phoneVerifiedAt: now, termsAcceptedAt: now };
      await prisma.user.upsert({
        where: { phone: u.phone },
        update: { name: u.name, role: u.role, email: u.email, status: "ACTIVE" },
        create: data,
      });
    }
    console.log(`  users: ${SEED_USERS.length} (admin ${SEED_USERS[0].phone}, buyer ${SEED_USERS[1].phone}, nursery owner ${SEED_USERS[2].phone})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
