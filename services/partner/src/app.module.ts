import { Global, Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import {
  DATABASE,
  InternalAuthGuard,
  JwtAuthGuard,
  MessagingModule,
  loadEnv,
  toDatabase,
} from "@nursery-co/platform";
import { PartnerEnv } from "./config/env";
import { HealthController } from "./health/health.controller";
import { MineController } from "./nurseries/mine.controller";
import { PlansController } from "./plans/plans.controller";
import { PrismaService } from "./prisma/prisma.service";
import { InternalController } from "./sellability/internal.controller";
import { SellabilityService } from "./sellability/sellability.service";

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw) => loadEnv(PartnerEnv, raw) as unknown as Record<string, unknown>,
    }),
    MessagingModule.forRoot({ service: "partner" }),
  ],
  controllers: [HealthController, PlansController, MineController, InternalController],
  providers: [
    PrismaService,
    { provide: DATABASE, inject: [PrismaService], useFactory: toDatabase },
    Reflector,
    InternalAuthGuard,
    JwtAuthGuard,
    SellabilityService,
  ],
  exports: [DATABASE],
})
export class AppModule {}
