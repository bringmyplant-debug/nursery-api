import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { type AccessClaims, CurrentUser, JwtAuthGuard } from "@nursery-co/platform";
import { AuthService } from "./auth.service";
import { RefreshDto, RequestOtpDto, SignupDto, UpdateProfileDto, VerifyOtpDto } from "./dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("otp/request")
  @HttpCode(200)
  @ApiOperation({
    summary: "Send a one-time code to a phone",
    description:
      "The first step of both sign-up and sign-in. The response is identical " +
      "whether or not the number already has an account.",
  })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phone);
  }

  @Post("otp/verify")
  @HttpCode(200)
  @ApiOperation({
    summary: "Check the code",
    description:
      "Returns `status: signed_in` with tokens for an existing account, or " +
      "`status: profile_required` with a short-lived `signupToken` for a new number.",
  })
  verifyOtp(@Body() dto: VerifyOtpDto, @Headers("user-agent") userAgent?: string) {
    return this.auth.verifyOtp(dto.phone, dto.code, userAgent);
  }

  @Post("signup")
  @ApiOperation({ summary: "Finish creating an account for a verified number" })
  signup(@Body() dto: SignupDto, @Headers("user-agent") userAgent?: string) {
    return this.auth.completeSignup(dto, userAgent);
  }

  @Post("refresh")
  @HttpCode(200)
  @ApiOperation({
    summary: "Exchange a refresh token for a new token pair",
    description:
      "Refresh tokens are single-use. 409 `refresh_in_flight` means another " +
      "request refreshed a moment ago: retry with the token it received. 401 means sign in again.",
  })
  refresh(@Body() dto: RefreshDto, @Headers("user-agent") userAgent?: string) {
    return this.auth.refresh(dto.refreshToken, userAgent);
  }

  @Post("logout")
  @HttpCode(204)
  @ApiOperation({ summary: "End this session. Always succeeds." })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  @Post("logout-all")
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "End every session for this account" })
  async logoutAll(@CurrentUser() user: AccessClaims): Promise<void> {
    await this.auth.logoutEverywhere(user.sub);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "The signed-in user" })
  async me(@CurrentUser() claims: AccessClaims) {
    const user = await this.auth.currentUser(claims.sub);
    // A token that is still valid for an account that has since been
    // suspended or removed must not keep working here.
    if (!user) throw new UnauthorizedException();
    return { user };
  }

  @Patch("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Update name or email. Phone and role cannot be changed here." })
  async updateMe(@CurrentUser() claims: AccessClaims, @Body() dto: UpdateProfileDto) {
    return { user: await this.auth.updateProfile(claims.sub, dto) };
  }
}
