/**
 * The smallest surface of a database client that the shared machinery
 * needs.
 *
 * Every service generates its own Prisma client from its own schema, so
 * this package cannot import any of them. It talks to Postgres through
 * these two raw-query methods, which every generated client and every
 * interactive-transaction client already has. Statements are static text
 * with `$1…$n` placeholders: values are always bound, never interpolated.
 */
export interface SqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface Database extends SqlClient {
  /**
   * Run `fn` in one transaction: everything inside commits together or
   * not at all. The outbox pattern lives or dies on this — a domain write
   * and its event must be atomic.
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>;
}

/** DI token a service provides its {@link Database} under. */
export const DATABASE = Symbol("DATABASE");

/** Structural shape of the parts of PrismaClient that `toDatabase` uses. */
export interface PrismaLike extends SqlClient {
  // Prisma overloads $transaction (array form, callback form). `any` here
  // is deliberate: the generated transaction client is a different type in
  // every service and this package must not know any of them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction(fn: (tx: any) => Promise<any>, options?: { maxWait?: number; timeout?: number }): Promise<any>;
}

/** Adapt a service's PrismaClient to the {@link Database} the platform expects. */
export function toDatabase(prisma: PrismaLike): Database {
  return {
    $queryRawUnsafe: (query, ...values) => prisma.$queryRawUnsafe(query, ...values),
    $executeRawUnsafe: (query, ...values) => prisma.$executeRawUnsafe(query, ...values),
    transaction: (fn, opts) =>
      prisma.$transaction((tx) => fn(tx as SqlClient), {
        // Prisma's defaults (2s wait, 5s run) are right for a request and
        // wrong for the relay, which holds a transaction across a network
        // publish. Callers that need longer say so.
        maxWait: 5_000,
        timeout: opts?.timeoutMs ?? 10_000,
      }),
  };
}
