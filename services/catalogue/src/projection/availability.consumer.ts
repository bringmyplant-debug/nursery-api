import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventTypes, isAvailabilityChanged } from "@nursery-co/contracts";
import { DATABASE, type Database, EVENT_BUS, EventConsumer, type EventBus } from "@nursery-co/platform";
import { applyAvailability } from "./availability.projection";

/** Durable consumer name. One per service, shared by every replica. */
export const CONSUMER_NAME = "catalogue";

/**
 * Keeps `variant_availability` in step with the inventory service.
 *
 * Starts from the beginning of the retained stream on first run, so a
 * newly deployed or rebuilt catalogue fills itself in without anyone
 * replaying anything by hand. If the stream has aged past what is needed,
 * the inventory service can re-announce everything:
 * `POST /internal/availability/rebuild?force=true`.
 */
@Injectable()
export class AvailabilityConsumer implements OnModuleInit {
  private readonly logger = new Logger(AvailabilityConsumer.name);
  private readonly consumer: EventConsumer;

  constructor(
    @Inject(DATABASE) db: Database,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {
    this.consumer = new EventConsumer(CONSUMER_NAME, db);
  }

  async onModuleInit(): Promise<void> {
    await this.bus.subscribe({
      durable: CONSUMER_NAME,
      subjects: ["inventory.>"],
      handler: async (event, meta) => {
        if (event.type !== EventTypes.InventoryAvailabilityChanged) {
          this.logger.debug(`ignoring ${event.type}`);
          return;
        }
        await this.consumer.consume(event, meta, async (tx, e) => {
          if (!isAvailabilityChanged(e.data)) {
            throw new Error(`malformed ${e.type} payload`);
          }
          await applyAvailability(tx, e.data);
        });
      },
    });
  }
}
