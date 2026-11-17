import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { IsEnum, IsOptional } from "class-validator";
import { InternalAuthGuard } from "@nursery-co/platform";
import { UserRole, UserStatus } from "../generated/prisma";
import { ConsoleSmsProvider, SMS_PROVIDER, type SmsProvider } from "../otp/sms.provider";
import { PrismaService } from "../prisma/prisma.service";
import { TokenService } from "../tokens/token.service";
import { normalizeIndianMobile } from "../users/phone";

class UpdateUserDto {
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

/**
 * Operator surface. Never routed by the gateway, and guarded by the shared
 * internal token as a second layer.
 */
@ApiExcludeController()
@UseGuards(InternalAuthGuard)
@Controller({ path: "internal", version: VERSION_NEUTRAL })
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  /**
   * Development only: the latest code sent to a number. It answers only
   * while the console SMS provider is configured, which production refuses
   * to start with, so it cannot exist where it would be a backdoor.
   */
  @Get("dev/otp/:phone")
  devOtp(@Param("phone") phone: string) {
    const normalized = normalizeIndianMobile(phone);
    if (!(this.sms instanceof ConsoleSmsProvider) || !normalized) throw new NotFoundException();
    const code = this.sms.peek(normalized);
    if (!code) throw new NotFoundException();
    return { phone: normalized, code };
  }

  /**
   * Promote, demote or suspend an account. Either change ends all of its
   * sessions: access tokens carry the role, so the person has to sign in
   * again to get one that reflects the change.
   */
  @Patch("users/:id")
  @HttpCode(200)
  async update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    const user = await this.prisma.user
      .update({ where: { id }, data: dto, select: { id: true, role: true, status: true } })
      .catch(() => null);
    if (!user) throw new NotFoundException();
    await this.tokens.revokeAllFor(id);
    return user;
  }
}
