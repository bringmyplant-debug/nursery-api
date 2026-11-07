import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { InternalAuthGuard } from "@nursery-co/platform";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateNurseryStatusDto, UpdateSubscriptionDto } from "./dto";
import { SellabilityService } from "./sellability.service";

/**
 * Operator and service-to-service surface. Never exposed by the gateway;
 * the guard is the second layer behind that.
 *
 * Every write here that can change whether a nursery may sell finishes by
 * reconciling that nursery, so the change is announced in the same breath.
 * The periodic sweep is the safety net, not the mechanism.
 */
@ApiExcludeController()
@UseGuards(InternalAuthGuard)
@Controller({ path: "internal", version: VERSION_NEUTRAL })
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sellability: SellabilityService,
  ) {}

  @Get("nurseries")
  async nurseries() {
    const rows = await this.prisma.nursery.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        city: true,
        status: true,
        sellability: { select: { sellable: true, version: true } },
      },
    });
    return { data: rows };
  }

  @Patch("nurseries/:id/status")
  async setStatus(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateNurseryStatusDto) {
    const result = await this.prisma.nursery
      .update({ where: { id }, data: { status: dto.status }, select: { id: true, status: true } })
      .catch(() => null);
    if (!result) throw new NotFoundException(`nursery ${id} not found`);
    return { ...result, sellability: await this.sellability.reconcileNursery(id) };
  }

  @Patch("subscriptions/:id")
  async updateSubscription(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateSubscriptionDto) {
    const result = await this.prisma.subscription
      .update({
        where: { id },
        data: {
          ...(dto.status ? { status: dto.status } : {}),
          ...(dto.currentPeriodEnd ? { currentPeriodEnd: new Date(dto.currentPeriodEnd) } : {}),
        },
        select: { id: true, nurseryId: true, status: true, currentPeriodEnd: true },
      })
      .catch(() => null);
    if (!result) throw new NotFoundException(`subscription ${id} not found`);
    return { ...result, sellability: await this.sellability.reconcileNursery(result.nurseryId) };
  }

  /** Run the expiry sweep now instead of waiting for the next tick. */
  @Post("sellability/reconcile")
  @HttpCode(200)
  async reconcile() {
    return { announced: await this.sellability.reconcileDrifted() };
  }

  /** Re-announce every nursery. For a newly added or rebuilt downstream service. */
  @Post("sellability/republish")
  @HttpCode(200)
  async republish() {
    return { republished: await this.sellability.republishAll() };
  }
}
