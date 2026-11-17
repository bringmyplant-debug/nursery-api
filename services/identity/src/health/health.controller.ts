import { Controller, Get, VERSION_NEUTRAL } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { runHealthChecks } from "@nursery-co/platform";
import { PrismaService } from "../prisma/prisma.service";

@ApiExcludeController()
@Controller({ path: "health", version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Identity needs only its database: it has no bus dependency. */
  @Get()
  health() {
    return runHealthChecks("identity", { database: () => this.prisma.ping() });
  }
}
