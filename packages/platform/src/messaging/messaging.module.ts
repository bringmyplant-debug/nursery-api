import { type DynamicModule, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DATABASE, type Database } from "../sql";
import { EVENT_BUS, type EventBus } from "./bus";
import { NatsEventBus } from "./nats-bus";
import { OutboxRelay } from "./outbox";

export interface MessagingOptions {
  /** Used as the NATS connection name and the event `producer`. */
  service: string;
}

/**
 * Wires the bus and the outbox relay into a service.
 *
 * The importing app must make {@link DATABASE} and a global ConfigModule
 * (with `NATS_URL`) available.
 */
@Module({})
export class MessagingModule {
  static forRoot(options: MessagingOptions): DynamicModule {
    return {
      module: MessagingModule,
      global: true,
      providers: [
        {
          provide: EVENT_BUS,
          inject: [ConfigService],
          useFactory: (config: ConfigService): EventBus =>
            new NatsEventBus({
              url: config.getOrThrow<string>("NATS_URL"),
              service: options.service,
            }),
        },
        {
          provide: OutboxRelay,
          inject: [DATABASE, EVENT_BUS],
          useFactory: (db: Database, bus: EventBus) => new OutboxRelay(db, bus),
        },
      ],
      exports: [EVENT_BUS, OutboxRelay],
    };
  }
}
