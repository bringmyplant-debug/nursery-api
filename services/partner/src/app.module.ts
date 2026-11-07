import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import {
  DATABASE,
  InternalAuthGuard,
  MessagingModule,
  loadEnv,
  toDatabase,
} from "@nursery-co/platform";
import { PartnerEnv } from "./config/env";
import { HealthController } from "./health/health.controller";
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
  controllers: [HealthController, PlansController, InternalController],
  providers: [
    PrismaService,
    { provide: DATABASE, inject: [PrismaService], useFactory: toDatabase },
    InternalAuthGuard,
    SellabilityService,
  ],
  exports: [DATABASE],
})
export class AppModule {}
