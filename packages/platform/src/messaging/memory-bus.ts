import type { EventEnvelope } from "@nursery-co/contracts";
import { type EventBus, type SubscribeOptions, subjectMatches } from "./bus";

/**
 * An in-process bus with the same delivery contract as the real one:
 * at-least-once, redelivered on failure, shared between consumers of the
 * same durable name.
 *
 * For unit tests, and for running a single service locally without a
 * broker. It is not a substitute in production: nothing survives a
 * restart and nothing crosses a process boundary, which is the entire
 * point of the real one.
 */
export class InMemoryEventBus implements EventBus {
  private readonly subscriptions: SubscribeOptions[] = [];
  /** Every event ever published, in order. Tests assert on this. */
  readonly published: EventEnvelope[] = [];
  /** Ids already accepted, mimicking the broker's de-duplication window. */
  private readonly seen = new Set<string>();

  constructor(private readonly maxDeliveries = 5) {}

  async publish(event: EventEnvelope): Promise<void> {
    if (this.seen.has(event.id)) return; // broker-side dedupe
    this.seen.add(event.id);
    this.published.push(event);

    // One delivery per distinct durable name, like a real consumer group.
    const delivered = new Set<string>();
    for (const sub of this.subscriptions) {
      if (delivered.has(sub.durable)) continue;
      if (!sub.subjects.some((filter) => subjectMatches(filter, event.type))) continue;
      delivered.add(sub.durable);
      await this.deliver(sub, event);
    }
  }

  async subscribe(options: SubscribeOptions): Promise<void> {
    this.subscriptions.push(options);
  }

  isHealthy(): boolean {
    return true;
  }

  async close(): Promise<void> {
    this.subscriptions.length = 0;
  }

  private async deliver(sub: SubscribeOptions, event: EventEnvelope): Promise<void> {
    for (let deliveryCount = 1; deliveryCount <= this.maxDeliveries; deliveryCount++) {
      try {
        await sub.handler(event, { deliveryCount });
        return;
      } catch {
        // Redeliver immediately; there is no clock to wait on in a test.
      }
    }
  }
}
