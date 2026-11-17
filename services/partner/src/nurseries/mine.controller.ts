import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { type AccessClaims, CurrentUser, JwtAuthGuard } from "@nursery-co/platform";
import { PrismaService } from "../prisma/prisma.service";

@ApiTags("nurseries")
@Controller("nurseries")
export class MineController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The nurseries the signed-in user may act for.
   *
   * Authorisation here is membership, never "is this user a nursery": one
   * account can run several outlets, and an empty list is the normal answer
   * for an ordinary buyer. The caller's identity comes from the verified
   * access token; no id is accepted from the client, so there is nothing to
   * tamper with to read someone else's list.
   */
  @Get("mine")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Nurseries the signed-in user belongs to" })
  async mine(@CurrentUser() user: AccessClaims) {
    const memberships = await this.prisma.nurseryMember.findMany({
      where: { userId: user.sub },
      orderBy: { joinedAt: "asc" },
      select: {
        role: true,
        nursery: { select: { id: true, slug: true, name: true, city: true, status: true } },
      },
    });
    return { data: memberships.map((m) => ({ role: m.role, ...m.nursery })) };
  }
}
