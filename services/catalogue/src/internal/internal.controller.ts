import { Controller, Get, Inject, VERSION_NEUTRAL, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { DATABASE, type Database, InternalAuthGuard } from "@nursery-co/platform";

@ApiExcludeController()
@UseGuards(InternalAuthGuard)
@Controller({ path: "internal", version: VERSION_NEUTRAL })
export class InternalController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * How fresh and how complete the availability projection is. The number
   * to look at when a price page and a stock page disagree.
   */
  @Get("projection/status")
  async status() {
    const [row] = await this.db.$queryRawUnsafe<
      { rows: number; sellableRows: number; lastAppliedAt: Date | null }[]
    >(
      `SELECT count(*)::int                                  AS rows,
              (count(*) FILTER (WHERE available > 0))::int   AS "sellableRows",
              max("updatedAt")                               AS "lastAppliedAt"
         FROM variant_availability`,
    );
    const [dead] = await this.db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM dead_letters WHERE resolved_at IS NULL`,
    );
    return { availability: row, unresolvedDeadLetters: dead?.n ?? 0 };
  }
}
