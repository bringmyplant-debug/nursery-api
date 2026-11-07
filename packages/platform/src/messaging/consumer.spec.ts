import type { EventEnvelope } from "@nursery-co/contracts";
import {
  MemoryDatabase,
  MemoryDeadLetterStore,
  MemoryProcessedStore,
  onRollback,
} from "../testing/memory-stores";
import { EventConsumer, type ConsumerOptions } from "./consumer";

const event = (id = "e1"): EventEnvelope => ({
  id,
  type: "partner.sellability.changed.v1",
  occurredAt: new Date().toISOString(),
  producer: "partner",
  data: {},
});

function setup(options: ConsumerOptions = {}) {
  const db = new MemoryDatabase();
  const dead = new MemoryDeadLetterStore();
  return { dead, consumer: new EventConsumer("svc", db, new MemoryProcessedStore(), dead, options) };
}

describe("EventConsumer", () => {
  it("runs the handler once and skips redeliveries of the same event", async () => {
    const { consumer } = setup();
    const handler = vi.fn().mockResolvedValue(undefined);

    expect(await consumer.consume(event(), { deliveryCount: 1 }, handler)).toBe("processed");
    expect(await consumer.consume(event(), { deliveryCount: 2 }, handler)).toBe("duplicate");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("treats distinct events independently", async () => {
    const { consumer } = setup();
    const handler = vi.fn().mockResolvedValue(undefined);
    await consumer.consume(event("a"), { deliveryCount: 1 }, handler);
    await consumer.consume(event("b"), { deliveryCount: 1 }, handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("rolls the processed mark back when the handler fails, so the retry runs again", async () => {
    const { consumer } = setup();
    let calls = 0;
    const handler = async (): Promise<void> => {
      if (++calls === 1) throw new Error("transient");
    };

    await expect(consumer.consume(event(), { deliveryCount: 1 }, handler)).rejects.toThrow("transient");
    expect(await consumer.consume(event(), { deliveryCount: 2 }, handler)).toBe("processed");
    expect(calls).toBe(2);
  });

  it("rolls back the handler's own writes with the mark", async () => {
    const { consumer } = setup();
    const writes: string[] = [];
    await expect(
      consumer.consume(event(), { deliveryCount: 1 }, async (tx) => {
        writes.push("row");
        onRollback(tx, () => writes.pop());
        throw new Error("fail after write");
      }),
    ).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("dead-letters and acknowledges once attempts are exhausted", async () => {
    const { consumer, dead } = setup({ maxAttempts: 3 });
    const handler = vi.fn().mockRejectedValue(new Error("poison"));

    await expect(consumer.consume(event(), { deliveryCount: 2 }, handler)).rejects.toThrow("poison");
    expect(dead.entries).toHaveLength(0);

    expect(await consumer.consume(event(), { deliveryCount: 3 }, handler)).toBe("dead-lettered");
    expect(dead.entries).toEqual([expect.objectContaining({ consumer: "svc", error: "poison", attempts: 3 })]);
    expect(dead.entries[0].envelope.id).toBe("e1");
  });

  it("calls onCommitted only for events that were actually applied", async () => {
    const onCommitted = vi.fn();
    const { consumer } = setup({ onCommitted });
    const ok = vi.fn().mockResolvedValue(undefined);

    await consumer.consume(event(), { deliveryCount: 1 }, ok);
    await consumer.consume(event(), { deliveryCount: 2 }, ok); // duplicate
    await consumer
      .consume(event("x"), { deliveryCount: 1 }, vi.fn().mockRejectedValue(new Error("x")))
      .catch(() => undefined);

    expect(onCommitted).toHaveBeenCalledTimes(1);
  });
});
