import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import {
  DATABASE,
  InternalAuthGuard,
  MessagingModule,
  loadEnv,
  toDatabase,
} from "@nursery-co/platform";
import { CatalogueController } from "./catalogue/catalogue.controller";
import { CatalogueService } from "./catalogue/catalogue.service";
import { CatalogueEnv } from "./config/env";
import { HealthController } from "./health/health.controller";
import { InternalController } from "./internal/internal.controller";
import { PrismaService } from "./prisma/prisma.service";
import { AvailabilityConsumer } from "./projection/availability.consumer";

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw) => loadEnv(CatalogueEnv, raw) as unknown as Record<string, unknown>,
    }),
    MessagingModule.forRoot({ service: "catalogue" }),
  ],
  controllers: [HealthController, CatalogueController, InternalController],
  providers: [
    PrismaService,
    { provide: DATABASE, inject: [PrismaService], useFactory: toDatabase },
    InternalAuthGuard,
    CatalogueService,
    AvailabilityConsumer,
  ],
  exports: [DATABASE],
})
export class AppModule {}
