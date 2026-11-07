import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import {
  DATABASE,
  InternalAuthGuard,
  MessagingModule,
  loadEnv,
  toDatabase,
} from "@nursery-co/platform";
import { InventoryEnv } from "./config/env";
import { SellabilityConsumer } from "./consumers/sellability.consumer";
import { HealthController } from "./health/health.controller";
import { PrismaService } from "./prisma/prisma.service";
import { InternalController } from "./stock/internal.controller";

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw) => loadEnv(InventoryEnv, raw) as unknown as Record<string, unknown>,
    }),
    MessagingModule.forRoot({ service: "inventory" }),
  ],
  controllers: [HealthController, InternalController],
  providers: [
    PrismaService,
    { provide: DATABASE, inject: [PrismaService], useFactory: toDatabase },
    InternalAuthGuard,
    SellabilityConsumer,
  ],
  exports: [DATABASE],
})
export class AppModule {}
