import { EventTypes, type EventEnvelope } from "@nursery-co/contracts";
import { MemoryDatabase, MemoryOutboxStore } from "../testing/memory-stores";
import type { EventBus } from "./bus";
import { InMemoryEventBus } from "./memory-bus";
import { OutboxRelay, enqueueEvent } from "./outbox";

const sellable = (nurseryId: string, version: number) => ({
  type: EventTypes.PartnerSellabilityChanged,
  data: { nurseryId, city: "Pune", sellable: true, reason: "initial" as const, version },
});

const stubBus = (publish: EventBus["publish"]): EventBus => ({
  publish,
  subscribe: async () => undefined,
  isHealthy: () => true,
  close: async () => undefined,
});

async function seed(store: MemoryOutboxStore, db: MemoryDatabase, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await db.transaction((tx) => enqueueEvent(tx, "partner", sellable(`n${i}`, i), store));
  }
}

describe("enqueueEvent", () => {
  it("builds a complete envelope and stores it", async () => {
    const db = new MemoryDatabase();
    const store = new MemoryOutboxStore();
    const envelope = await db.transaction((tx) =>
      enqueueEvent(tx, "partner", { ...sellable("n1", 1), correlationId: "req-1" }, store),
    );
    expect(envelope).toMatchObject({
      type: EventTypes.PartnerSellabilityChanged,
      producer: "partner",
      correlationId: "req-1",
    });
    expect(envelope.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.pending).toEqual([envelope]);
  });

  it("omits correlationId when none is given", async () => {
    const db = new MemoryDatabase();
    const envelope = await db.transaction((tx) =>
      enqueueEvent(tx, "partner", sellable("n1", 1), new MemoryOutboxStore()),
    );
    expect("correlationId" in envelope).toBe(false);
  });

  it("is atomic with the caller's transaction: a rollback discards the event", async () => {
    const db = new MemoryDatabase();
    const store = new MemoryOutboxStore();
    await expect(
      db.transaction(async (tx) => {
        await enqueueEvent(tx, "partner", sellable("n1", 1), store);
        throw new Error("domain write failed");
      }),
    ).rejects.toThrow("domain write failed");
    expect(store.pending).toHaveLength(0);
  });
});

describe("OutboxRelay", () => {
  it("publishes in insertion order and marks events published", async () => {
    const db = new MemoryDatabase();
    const store = new MemoryOutboxStore();
    const bus = new InMemoryEventBus();
    await seed(store, db, 5);

    const result = await new OutboxRelay(db, bus, store, { batchSize: 2 }).drain();

    expect(result).toEqual({ published: 5, failed: false });
    expect(bus.published.map((e) => (e.data as { nurseryId: string }).nurseryId)).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
    expect(store.pending).toHaveLength(0);
  });

  it("stops at the first failure so later events cannot overtake it, and keeps what did go out", async () => {
    const db = new MemoryDatabase();
    const store = new MemoryOutboxStore();
    await seed(store, db, 4);

    const sent: string[] = [];
    let failNext = true;
    const relay = new OutboxRelay(
      db,
      stubBus(async (e: EventEnvelope) => {
        if (e.id === store.entries[2].envelope.id && failNext) throw new Error("broker down");
        sent.push(e.id);
      }),
      store,
    );

    expect(await relay.drain()).toEqual({ published: 2, failed: true });
    expect(sent).toEqual([store.entries[0].envelope.id, store.entries[1].envelope.id]);
    expect(store.entries[2].attempts).toBe(1);
    expect(store.entries[2].lastError).toBe("broker down");
    expect(store.pending).toHaveLength(2);

    failNext = false;
    expect(await relay.drain()).toEqual({ published: 2, failed: false });
    expect(sent).toEqual(store.entries.map((e) => e.envelope.id));
  });

  it("a crash between publish and mark-published causes a re-send the broker dedupes", async () => {
    const db = new MemoryDatabase();
    const store = new MemoryOutboxStore();
    const bus = new InMemoryEventBus();
    await seed(store, db, 1);

    // Publish succeeded, but the relay died before committing "published".
    await bus.publish(store.entries[0].envelope);
    await new OutboxRelay(db, bus, store).drain();

    expect(bus.published).toHaveLength(1);
    expect(store.pending).toHaveLength(0);
  });

  it("does not run two drains at once", async () => {
    const db = new MemoryDatabase();
    const store = new MemoryOutboxStore();
    await seed(store, db, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const relay = new OutboxRelay(db, stubBus(() => gate), store);

    const first = relay.drain();
    expect(await relay.drain()).toEqual({ published: 0, failed: false });
    release();
    expect(await first).toEqual({ published: 1, failed: false });
  });

  it("is a no-op on an empty outbox", async () => {
    const relay = new OutboxRelay(new MemoryDatabase(), new InMemoryEventBus(), new MemoryOutboxStore());
    expect(await relay.drain()).toEqual({ published: 0, failed: false });
  });
});
