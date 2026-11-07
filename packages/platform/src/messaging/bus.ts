import type { EventEnvelope } from "@nursery-co/contracts";

/** What a handler learns about how the event reached it. */
export interface DeliveryMeta {
  /** 1 on first delivery, incrementing on each redelivery after a failure. */
  deliveryCount: number;
}

export interface SubscribeOptions {
  /**
   * Durable consumer name — one per consuming *service*, not per replica.
   * Replicas of the same service share a name and the broker spreads
   * messages between them; a different name would deliver every event to
   * every replica and process it N times.
   */
  durable: string;
  /** Subject filters. `*` matches one token, `>` matches the rest. */
  subjects: string[];
  /**
   * Resolve to acknowledge; reject to ask for redelivery after a backoff.
   * A rejection is never "lost" — the broker holds the message until a
   * delivery succeeds or the service gives up and dead-letters it.
   */
  handler: (event: EventEnvelope, meta: DeliveryMeta) => Promise<void>;
}

/**
 * The seam between services and whatever broker carries their events.
 *
 * Services and the outbox relay depend on this interface, never on NATS,
 * so the broker is a deployment decision rather than a code one: swapping
 * to SNS/SQS or Kafka is a new adapter, not a change to any service.
 */
export interface EventBus {
  /** Rejects if the event could not be durably accepted. */
  publish(event: EventEnvelope): Promise<void>;

  /**
   * Register a consumer. Returns once registered — not once connected —
   * so a service can boot before the broker is reachable and begin
   * consuming when it is.
   */
  subscribe(options: SubscribeOptions): Promise<void>;

  isHealthy(): boolean;
  close(): Promise<void>;
}

/** DI token a service's {@link EventBus} is provided under. */
export const EVENT_BUS = Symbol("EVENT_BUS");

/**
 * NATS-style subject matching: tokens are dot-separated, `*` stands for
 * exactly one token and `>` for one or more trailing tokens.
 */
export function subjectMatches(filter: string, subject: string): boolean {
  const f = filter.split(".");
  const s = subject.split(".");

  for (let i = 0; i < f.length; i++) {
    if (f[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (f[i] !== "*" && f[i] !== s[i]) return false;
  }
  return f.length === s.length;
}
