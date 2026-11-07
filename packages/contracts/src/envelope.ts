/**
 * The wrapper around every event on the bus.
 *
 * Everything a consumer needs to deduplicate, order and trace an event is
 * in the envelope, so no handler has to look inside `data` for it.
 */
export interface EventEnvelope<TType extends string = string, TData = unknown> {
  /**
   * Unique per event, generated once when the event is written to the
   * producer's outbox. Two things key off it:
   *  - the relay sends it as the broker's de-duplication id, so a relay
   *    that crashes between "published" and "marked published" does not
   *    produce a second copy;
   *  - consumers record it, so a redelivery is processed exactly once.
   */
  id: string;

  /**
   * `<producer>.<noun>.<verb>.v<major>`, e.g. `inventory.availability.changed.v1`.
   * Doubles as the broker subject, so consumers can filter with wildcards.
   *
   * A breaking change to `data` is a NEW type (`…v2`) published alongside
   * the old one until every consumer has moved. It is never a silent edit
   * to the existing shape — an old consumer would parse the new payload
   * "successfully" and act on the wrong fields.
   */
  type: TType;

  /** ISO-8601, UTC. When the thing happened, not when it was delivered. */
  occurredAt: string;

  /** The service that wrote it. */
  producer: string;

  /** The request that caused it, when there was one. For tracing only. */
  correlationId?: string;

  data: TData;
}
