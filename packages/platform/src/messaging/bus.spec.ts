import type { EventEnvelope } from "@nursery-co/contracts";
import { subjectMatches } from "./bus";
import { InMemoryEventBus } from "./memory-bus";

describe("subjectMatches", () => {
  it.each([
    ["partner.>", "partner.sellability.changed.v1", true],
    ["partner.>", "partner", false],
    ["partner.*.changed.v1", "partner.sellability.changed.v1", true],
    ["partner.*", "partner.sellability.changed.v1", false],
    ["inventory.>", "partner.sellability.changed.v1", false],
    ["a.b", "a.b", true],
    ["a.b", "a.b.c", false],
    ["a.b.c", "a.b", false],
  ])("%s vs %s -> %s", (filter, subject, expected) => {
    expect(subjectMatches(filter, subject)).toBe(expected);
  });
});

const evt = (id: string, type = "partner.sellability.changed.v1"): EventEnvelope => ({
  id,
  type,
  occurredAt: new Date().toISOString(),
  producer: "test",
  data: {},
});

describe("InMemoryEventBus", () => {
  it("drops a republished id like the broker's dedupe window", async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    await bus.subscribe({ durable: "d", subjects: ["partner.>"], handler });

    await bus.publish(evt("1"));
    await bus.publish(evt("1"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(1);
  });

  it("delivers once per durable name, not once per subscriber", async () => {
    const bus = new InMemoryEventBus();
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    await bus.subscribe({ durable: "same", subjects: ["partner.>"], handler: a });
    await bus.subscribe({ durable: "same", subjects: ["partner.>"], handler: b });
    await bus.publish(evt("1"));
    expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
  });

  it("redelivers on failure with an increasing delivery count", async () => {
    const bus = new InMemoryEventBus();
    const counts: number[] = [];
    await bus.subscribe({
      durable: "d",
      subjects: ["partner.>"],
      handler: async (_e, meta) => {
        counts.push(meta.deliveryCount);
        if (meta.deliveryCount < 3) throw new Error("boom");
      },
    });
    await bus.publish(evt("1"));
    expect(counts).toEqual([1, 2, 3]);
  });

  it("does not deliver events outside the subscription's filter", async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    await bus.subscribe({ durable: "d", subjects: ["inventory.>"], handler });
    await bus.publish(evt("1"));
    expect(handler).not.toHaveBeenCalled();
  });
});
