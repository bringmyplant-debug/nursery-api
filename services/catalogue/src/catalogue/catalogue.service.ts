import { Injectable, NotFoundException } from "@nestjs/common";
import { type Page, decodeCursor, encodeCursor, toPage } from "@nursery-co/platform";
import { Prisma } from "../generated/prisma";
import { PrismaService } from "../prisma/prisma.service";
import { ListPlantsQuery, PlantSort } from "./dto/list-plants.query";

/** Shape returned by the list query, before mapping to the API response. */
export interface PlantRow {
  id: string;
  slug: string;
  commonName: string;
  botanicalName: string;
  family: string | null;
  summary: string;
  status: string;
  lightNeed: string;
  waterNeed: string;
  waterEveryDays: number;
  difficulty: string;
  placement: string;
  season: string;
  petSafe: boolean;
  airPurifying: boolean;
  lowMaintenance: boolean;
  flowering: boolean;
  matureSize: string | null;
  tags: string[];
  publishedAt: Date | null;
  categorySlug: string;
  categoryName: string;
  imageUrl: string | null;
  /**
   * Cheapest and dearest active variant in the requested city. Both null
   * when no city was given; see {@link CatalogueService.priceExpr}.
   */
  fromPaise: number | null;
  toPaise: number | null;
  variantCount: number;
  /** Buyable units across every nursery selling in the requested city. */
  totalStock: number;
  sortKey: string;
}

/**
 * The storefront's read model.
 *
 * Everything here is answered from this service's own database. Stock comes
 * from `variant_availability`, the projection of what the inventory service
 * announces, so a page view is one query and does not depend on any other
 * service being up. The price of that is eventual consistency: a stock
 * change reaches the page after the event does, typically milliseconds and
 * at worst however long the bus or a service has been down. The listing is
 * therefore a hint, not a promise; the authoritative stock check happens at
 * order time, under a row lock, in the service that owns the stock.
 */
@Injectable()
export class CatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Buyable stock per variant, resolved against one city, or summed over
   * all of them when no city is given.
   *
   * Whether a nursery is currently allowed to sell (active, subscription
   * live) is already baked into these numbers upstream, so no subscription
   * or nursery table is consulted here.
   */
  private availabilityCte(city?: string): Prisma.Sql {
    return city
      ? Prisma.sql`SELECT "variantId", available, holders
                     FROM variant_availability WHERE city = ${city}`
      : Prisma.sql`SELECT "variantId", SUM(available)::int AS available, SUM(holders)::int AS holders
                     FROM variant_availability GROUP BY "variantId"`;
  }

  /**
   * The price expression, resolved against one city.
   *
   * There is no such thing as the price of a SKU, only its price in a
   * market: what it costs a nursery to keep a plant alive is a local fact,
   * so a VariantCityPrice row overrides the national base per city. Absent
   * rows fall back to the base, which keeps a newly published SKU sellable
   * everywhere rather than only where somebody remembered to price it.
   *
   * Without a city this emits NULL rather than the base. That is
   * deliberate: a client that forgot to say where the reader is should get
   * no number at all, not a plausible-looking one it will render as though
   * it were a quote.
   */
  private priceExpr(city?: string): Prisma.Sql {
    return city ? Prisma.sql`COALESCE(cp."pricePaise", v."basePricePaise")` : Prisma.sql`NULL::int`;
  }

  private mrpExpr(city?: string): Prisma.Sql {
    return city ? Prisma.sql`COALESCE(cp."mrpPaise", v."baseMrpPaise")` : Prisma.sql`NULL::int`;
  }

  /** Joined only when there is a city to join on. */
  private priceJoin(city?: string): Prisma.Sql {
    return city
      ? Prisma.sql`LEFT JOIN variant_city_prices cp ON cp."variantId" = v.id AND cp.city = ${city}`
      : Prisma.empty;
  }

  async listPlants(query: ListPlantsQuery): Promise<Page<PlantRow>> {
    const { limit, sort, city } = query;

    const sortKey = this.sortKeyExpr(sort);
    const direction = this.sortDirection(sort);

    const cursor = decodeCursor<{ k: string; id: string }>(query.cursor);
    const cursorClause = cursor
      ? direction === "ASC"
        ? Prisma.sql`AND (t."sortKey" > ${cursor.k} OR (t."sortKey" = ${cursor.k} AND t.id > ${cursor.id}::uuid))`
        : Prisma.sql`AND (t."sortKey" < ${cursor.k} OR (t."sortKey" = ${cursor.k} AND t.id > ${cursor.id}::uuid))`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<PlantRow[]>`
      WITH avail AS (
        ${this.availabilityCte(city)}
      ),
      variant_stock AS (
        SELECT
          v.id        AS variant_id,
          v."plantId" AS plant_id,
          ${this.priceExpr(city)} AS "pricePaise",
          COALESCE(a.available, 0)::int AS stock
        FROM plant_variants v
        ${this.priceJoin(city)}
        LEFT JOIN avail a ON a."variantId" = v.id
        WHERE v."isActive" = true
      ),
      plant_stats AS (
        SELECT
          plant_id,
          MIN("pricePaise")       AS "fromPaise",
          MAX("pricePaise")       AS "toPaise",
          COUNT(*)::int           AS "variantCount",
          SUM(stock)::int         AS "totalStock"
        FROM variant_stock
        GROUP BY plant_id
      ),
      hero AS (
        SELECT DISTINCT ON ("plantId") "plantId", url
        FROM plant_images
        ORDER BY "plantId", "sortOrder" ASC, "createdAt" ASC
      ),
      base AS (
        SELECT
          p.id, p.slug, p."commonName", p."botanicalName", p.family, p.summary,
          p.status::text                       AS status,
          p."lightNeed"::text                  AS "lightNeed",
          p."waterNeed"::text                  AS "waterNeed",
          p."waterEveryDays",
          p.difficulty::text                   AS difficulty,
          p.placement::text                    AS placement,
          p.season::text                       AS season,
          p."petSafe", p."airPurifying", p."lowMaintenance", p.flowering,
          p."matureSize", p.tags, p."publishedAt",
          c.slug                               AS "categorySlug",
          c.name                               AS "categoryName",
          h.url                                AS "imageUrl",
          s."fromPaise", s."toPaise",
          COALESCE(s."variantCount", 0)::int   AS "variantCount",
          COALESCE(s."totalStock", 0)::int     AS "totalStock",
          ${sortKey}                           AS "sortKey"
        FROM plants p
        JOIN categories c ON c.id = p."categoryId"
        LEFT JOIN plant_stats s ON s.plant_id = p.id
        LEFT JOIN hero h ON h."plantId" = p.id
        WHERE p.status = 'PUBLISHED'
          ${this.filters(query)}
      )
      SELECT * FROM base t
      WHERE 1 = 1
        ${cursorClause}
      ORDER BY t."sortKey" ${direction === "ASC" ? Prisma.sql`ASC` : Prisma.sql`DESC`}, t.id ASC
      LIMIT ${limit + 1}
    `;

    return toPage(rows, limit, (row) => encodeCursor({ k: row.sortKey, id: row.id }));
  }

  /**
   * Sort keys are rendered as zero-padded text so one comparison works for
   * every sort, numeric and alphabetic alike, which keeps the cursor logic
   * to a single branch instead of one per sort mode.
   */
  private sortKeyExpr(sort: PlantSort): Prisma.Sql {
    switch (sort) {
      case PlantSort.PriceAsc:
      case PlantSort.PriceDesc:
        // Unpriced plants sort last under ASC.
        return Prisma.sql`lpad(COALESCE(s."fromPaise", 2147483647)::text, 10, '0')`;
      case PlantSort.Name:
        return Prisma.sql`lower(p."commonName")`;
      case PlantSort.Newest:
        return Prisma.sql`to_char(COALESCE(p."publishedAt", p."createdAt"), 'YYYYMMDDHH24MISS')`;
      case PlantSort.Popular:
      default:
        // Stands in for demand data we do not have: how much stock the
        // network is actually carrying.
        return Prisma.sql`lpad(COALESCE(s."totalStock", 0)::text, 8, '0')`;
    }
  }

  private sortDirection(sort: PlantSort): "ASC" | "DESC" {
    return sort === PlantSort.PriceDesc || sort === PlantSort.Popular || sort === PlantSort.Newest
      ? "DESC"
      : "ASC";
  }

  private filters(q: ListPlantsQuery): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (q.q?.trim()) {
      const needle = `%${q.q.trim()}%`;
      parts.push(Prisma.sql`AND (
        p."commonName" ILIKE ${needle}
        OR p."botanicalName" ILIKE ${needle}
        OR p.family ILIKE ${needle}
        OR EXISTS (SELECT 1 FROM unnest(p.tags) tag WHERE tag ILIKE ${needle})
      )`);
    }
    if (q.category) parts.push(Prisma.sql`AND c.slug = ${q.category}`);
    if (q.light?.length) parts.push(Prisma.sql`AND p."lightNeed"::text = ANY(${q.light})`);
    if (q.water?.length) parts.push(Prisma.sql`AND p."waterNeed"::text = ANY(${q.water})`);
    if (q.difficulty?.length) parts.push(Prisma.sql`AND p.difficulty::text = ANY(${q.difficulty})`);
    if (q.season) parts.push(Prisma.sql`AND p.season::text IN (${q.season}, 'ALL_SEASON')`);
    if (q.placement) parts.push(Prisma.sql`AND p.placement::text IN (${q.placement}, 'BOTH')`);
    if (q.petSafe) parts.push(Prisma.sql`AND p."petSafe" = true`);
    if (q.airPurifying) parts.push(Prisma.sql`AND p."airPurifying" = true`);
    if (q.flowering) parts.push(Prisma.sql`AND p.flowering = true`);

    if (q.maxPricePaise !== undefined) {
      parts.push(Prisma.sql`AND s."fromPaise" IS NOT NULL AND s."fromPaise" <= ${q.maxPricePaise}`);
    }
    if (q.inStockOnly) parts.push(Prisma.sql`AND COALESCE(s."totalStock", 0) > 0`);

    return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
  }

  /**
   * One plant with its buyable variants.
   *
   * Each variant carries admin's price and the stock summed across every
   * nursery. Which nursery supplies it is an allocation decision taken at
   * checkout, so it is deliberately not exposed here: the buyer picks a
   * size, not a seller.
   */
  async getPlantBySlug(slug: string, city?: string) {
    const plant = await this.prisma.plant.findFirst({
      where: { slug, status: "PUBLISHED" },
      include: {
        category: { select: { slug: true, name: true } },
        images: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
    });

    if (!plant) throw new NotFoundException(`No published plant with slug "${slug}"`);

    const variants = await this.prisma.$queryRaw<
      {
        id: string;
        sku: string;
        label: string;
        potSize: string;
        potMaterial: string | null;
        heightCm: number | null;
        pricePaise: number | null;
        mrpPaise: number | null;
        taxRateBps: number;
        totalStock: number;
        nurseryCount: number;
      }[]
    >`
      WITH avail AS (
        ${this.availabilityCte(city)}
      )
      SELECT
        v.id, v.sku, v.label, v."potSize", v."potMaterial", v."heightCm",
        ${this.priceExpr(city)} AS "pricePaise",
        ${this.mrpExpr(city)} AS "mrpPaise",
        v."taxRateBps",
        COALESCE(a.available, 0)::int AS "totalStock",
        COALESCE(a.holders, 0)::int   AS "nurseryCount"
      FROM plant_variants v
      ${this.priceJoin(city)}
      LEFT JOIN avail a ON a."variantId" = v.id
      WHERE v."plantId" = ${plant.id}::uuid AND v."isActive" = true
      ORDER BY v."sortOrder" ASC
    `;

    const inStock = variants.filter((v) => v.totalStock > 0);
    const prices = variants.map((v) => v.pricePaise).filter((p): p is number => p !== null);

    return {
      ...plant,
      /** Echoed back so a client can never mistake whose prices these are. */
      priceCity: city ?? null,
      variants,
      // No city, no summary. The storefront needs to tell the reader to
      // pick one rather than render a range it has no basis for.
      priceSummary: prices.length
        ? {
            fromPaise: Math.min(...prices),
            toPaise: Math.max(...prices),
            totalStock: variants.reduce((sum, v) => sum + v.totalStock, 0),
            variantsInStock: inStock.length,
          }
        : null,
    };
  }

  async listCategories() {
    return this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { slug: true, name: true, blurb: true, _count: { select: { plants: true } } },
    });
  }

  async listCollections() {
    return this.prisma.collection.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      select: {
        slug: true,
        title: true,
        tagline: true,
        description: true,
        imageUrl: true,
        _count: { select: { plants: true } },
      },
    });
  }

  async getCollectionBySlug(slug: string) {
    const collection = await this.prisma.collection.findFirst({
      where: { slug, isActive: true },
      include: {
        plants: {
          orderBy: { sortOrder: "asc" },
          include: {
            plant: {
              include: {
                category: { select: { slug: true, name: true } },
                images: { take: 1, orderBy: { sortOrder: "asc" } },
              },
            },
          },
        },
      },
    });

    if (!collection) throw new NotFoundException(`No collection with slug "${slug}"`);

    return {
      ...collection,
      plants: collection.plants.map((cp) => cp.plant).filter((p) => p.status === "PUBLISHED"),
    };
  }
}
