import { Controller, Get, Inject, VERSION_NEUTRAL } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { EVENT_BUS, type EventBus, OutboxRelay, runHealthChecks } from "@nursery-co/platform";
import { PrismaService } from "../prisma/prisma.service";

@ApiExcludeController()
@Controller({ path: "health", version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: OutboxRelay,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  /**
   * Degraded, not down, when the bus is unreachable: stock writes keep
   * working and the announcements queue in the outbox until it returns.
   */
  @Get()
  health() {
    return runHealthChecks(
      "inventory",
      { database: () => this.prisma.ping(), bus: async () => this.bus.isHealthy() },
      async () => ({ outbox: await this.relay.stats() }),
    );
  }
}
