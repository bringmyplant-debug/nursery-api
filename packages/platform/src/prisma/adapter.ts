import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Driver adapter for a service's Prisma client. Each service passes the
 * result to its *own* generated client; the platform never imports one.
 */
export function createPgAdapter(connectionString: string, poolSize = 10): PrismaPg {
  return new PrismaPg({ connectionString, max: poolSize });
}
