import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { DATABASE, type Database, InternalAuthGuard, OutboxRelay } from "@nursery-co/platform";
import { AvailabilityEngine } from "../availability/availability.engine";
import { SetStockDto } from "./dto";

/**
 * Stock management and operations. Internal only: nurseries will reach it
 * through an authenticated partner-facing API later; until then these are
 * the operator's and the seed's levers.
 */
@ApiExcludeController()
@UseGuards(InternalAuthGuard)
@Controller({ path: "internal", version: VERSION_NEUTRAL })
export class InternalController {
  private readonly engine: AvailabilityEngine;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly relay: OutboxRelay,
  ) {
    this.engine = new AvailabilityEngine(db);
  }

  @Put("stock/:nurseryId/:variantId")
  async setStock(
    @Param("nurseryId", ParseUUIDPipe) nurseryId: string,
    @Param("variantId", ParseUUIDPipe) variantId: string,
    @Body() dto: SetStockDto,
  ) {
    if (dto.reserved !== undefined && dto.reserved > dto.stock) {
      throw new BadRequestException("reserved cannot exceed stock");
    }
    try {
      await this.engine.setStock(nurseryId, variantId, dto);
    } catch (error) {
      // The CHECK constraint is the real guard; this turns its violation
      // (lowering stock below what is already reserved) into a 409, not a 500.
      if (String(error).includes("inventory_quantities_check")) {
        throw new ConflictException("stock cannot be set below the quantity already reserved");
      }
      throw error;
    }
    this.relay.kick();
    return { nurseryId, variantId, ...dto };
  }

  @Get("stock")
  async list(@Query("nurseryId") nurseryId?: string) {
    const rows = await this.db.$queryRawUnsafe(
      `SELECT "nurseryId", "variantId", stock, reserved, condition::text AS condition, "isActive"
         FROM inventory
        WHERE ($1::uuid IS NULL OR "nurseryId" = $1::uuid)
        ORDER BY "nurseryId", "variantId"
        LIMIT 500`,
      nurseryId ?? null,
    );
    return { data: rows };
  }

  @Get("availability")
  async availability(@Query("variantId") variantId?: string) {
    const rows = await this.db.$queryRawUnsafe(
      `SELECT "variantId", city, available, holders, version
         FROM availability
        WHERE ($1::uuid IS NULL OR "variantId" = $1::uuid)
        ORDER BY "variantId", city
        LIMIT 500`,
      variantId ?? null,
    );
    return { data: rows };
  }

  /** Recompute every total; `force=true` re-announces all of them. */
  @Post("availability/rebuild")
  @HttpCode(200)
  async rebuild(@Query("force") force?: string) {
    const result = await this.engine.rebuildAll(force === "true");
    this.relay.kick();
    return result;
  }
}
