import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../prisma/prisma.service";

@ApiTags("plans")
@Controller("plans")
export class PlansController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "Partner subscription plans, cheapest first" })
  async list() {
    const plans = await this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: {
        tier: true,
        name: true,
        blurb: true,
        monthlyPaise: true,
        annualPaise: true,
        listingLimit: true,
        features: true,
      },
    });
    return { data: plans };
  }
}
