import { Global, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { InternalAuthGuard, JwtAuthGuard, PeriodicJob } from "@nursery-co/platform";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { validateIdentityEnv } from "./config/env";
import { SETTINGS, settingsFrom, type IdentitySettings } from "./config/settings";
import { HealthController } from "./health/health.controller";
import { InternalController } from "./internal/internal.controller";
import { OtpService } from "./otp/otp.service";
import { ConsoleSmsProvider, Msg91SmsProvider, SMS_PROVIDER, type SmsProvider } from "./otp/sms.provider";
import { PrismaService } from "./prisma/prisma.service";
import { TokenService } from "./tokens/token.service";

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateIdentityEnv })],
  controllers: [HealthController, AuthController, InternalController],
  providers: [
    PrismaService,
    Reflector,
    InternalAuthGuard,
    JwtAuthGuard,
    { provide: SETTINGS, inject: [ConfigService], useFactory: settingsFrom },
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SmsProvider =>
        config.get("SMS_PROVIDER") === "msg91"
          ? new Msg91SmsProvider({
              authKey: config.getOrThrow("MSG91_AUTH_KEY"),
              templateId: config.getOrThrow("MSG91_TEMPLATE_ID"),
              otpVariable: config.get("MSG91_OTP_VARIABLE") ?? "OTP",
            })
          : new ConsoleSmsProvider(),
    },
    {
      provide: OtpService,
      inject: [PrismaService, SMS_PROVIDER, SETTINGS],
      useFactory: (prisma: PrismaService, sms: SmsProvider, settings: IdentitySettings) =>
        new OtpService(prisma, sms, settings),
    },
    {
      provide: TokenService,
      inject: [PrismaService, SETTINGS],
      useFactory: (prisma: PrismaService, settings: IdentitySettings) => new TokenService(prisma, settings),
    },
    {
      provide: AuthService,
      inject: [PrismaService, OtpService, TokenService, SETTINGS],
      useFactory: (prisma: PrismaService, otp: OtpService, tokens: TokenService, settings: IdentitySettings) =>
        new AuthService(prisma, otp, tokens, settings),
    },
  ],
})
export class AppModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AppModule.name);
  private readonly cleanup: PeriodicJob;

  constructor(otp: OtpService, tokens: TokenService) {
    this.cleanup = new PeriodicJob(
      async () => {
        const [codes, sessions] = await Promise.all([otp.purge(), tokens.purge()]);
        if (codes + sessions > 0) this.logger.log(`purged ${codes} old code(s) and ${sessions} old session token(s)`);
      },
      3_600_000,
      (error) => this.logger.error(`cleanup failed: ${error instanceof Error ? error.message : error}`),
    );
  }

  onApplicationBootstrap(): void {
    this.cleanup.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.cleanup.stop();
  }
}
