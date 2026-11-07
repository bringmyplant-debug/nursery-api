import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration. The URL lives here, not in schema.prisma
 * (Prisma 7); the running service gets its connection through a driver
 * adapter. Falls back to an empty string so `prisma generate`, which
 * never connects, works without a .env present.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ?? "",
  },
});
