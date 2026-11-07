import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventTypes, isSellabilityChanged } from "@nursery-co/contracts";
import {
  DATABASE,
  type Database,
  EVENT_BUS,
  EventConsumer,
  type EventBus,
  OutboxRelay,
} from "@nursery-co/platform";
import { AvailabilityEngine } from "../availability/availability.engine";

/** Durable consumer name. One per service, shared by every replica. */
export const CONSUMER_NAME = "inventory";

/**
 * Listens to the partner service and keeps this service's copy of "which
 * nurseries may sell, and where" current.
 *
 * Subscribes to the whole `partner.>` namespace so a new partner event type
 * needs no change to the subscription; types this service does not know are
 * acknowledged and ignored, not retried.
 */
@Injectable()
export class SellabilityConsumer implements OnModuleInit {
  private readonly logger = new Logger(SellabilityConsumer.name);
  private readonly engine: AvailabilityEngine;
  private readonly consumer: EventConsumer;

  constructor(
    @Inject(DATABASE) db: Database,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    relay: OutboxRelay,
  ) {
    this.engine = new AvailabilityEngine(db);
    this.consumer = new EventConsumer(CONSUMER_NAME, db, undefined, undefined, {
      // Applying an event can queue availability announcements; send them now.
      onCommitted: () => relay.kick(),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.bus.subscribe({
      durable: CONSUMER_NAME,
      subjects: ["partner.>"],
      handler: async (event, meta) => {
        if (event.type !== EventTypes.PartnerSellabilityChanged) {
          this.logger.debug(`ignoring ${event.type}`);
          return;
        }
        await this.consumer.consume(event, meta, async (tx, e) => {
          if (!isSellabilityChanged(e.data)) {
            // A producer bug, not a transient fault: retrying cannot fix it,
            // so it goes to the dead-letter table after the usual attempts.
            throw new Error(`malformed ${e.type} payload`);
          }
          await this.engine.applySellability(tx, e.data);
        });
      },
    });
  }
}
