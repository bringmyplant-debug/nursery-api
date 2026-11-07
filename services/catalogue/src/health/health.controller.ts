import { Controller, Get, Inject, VERSION_NEUTRAL } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { EVENT_BUS, type EventBus, runHealthChecks } from "@nursery-co/platform";
import { PrismaService } from "../prisma/prisma.service";

@ApiExcludeController()
@Controller({ path: "health", version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  /**
   * Degraded, not down, when the bus is unreachable: the storefront keeps
   * answering from the last availability it received. Slightly stale stock
   * is a far better failure than no catalogue.
   */
  @Get()
  health() {
    return runHealthChecks("catalogue", {
      database: () => this.prisma.ping(),
      bus: async () => this.bus.isHealthy(),
    });
  }
}
