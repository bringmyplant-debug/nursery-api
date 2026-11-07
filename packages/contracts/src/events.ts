import type { EventEnvelope } from "./envelope";

/**
 * The event catalogue.
 *
 * Add an event here, with its guard below, before producing or consuming
 * it. This file is the only coupling between services, and it is
 * deliberately narrow: a service that needs a fact from another service
 * hears about it in one of these, rather than reaching into a table.
 */
export const EventTypes = {
  /** partner → inventory: a nursery can, or can no longer, sell. */
  PartnerSellabilityChanged: "partner.sellability.changed.v1",

  /** inventory → catalogue: how many of a variant are buyable in a city. */
  InventoryAvailabilityChanged: "inventory.availability.changed.v1",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

/* -------------------------------------------------- partner.sellability */

/**
 * Why a nursery's sellability flipped. Diagnostic only — consumers must act
 * on `sellable`, never branch on the reason.
 */
export type SellabilityReason =
  | "initial"
  | "subscription-lapsed"
  | "subscription-renewed"
  | "status-changed"
  | "relocated"
  | "rebuild";

/**
 * Whether one nursery's stock may currently be sold.
 *
 * `sellable` is the platform's business rule, computed in exactly one
 * place — the partner service — and shipped as a fact: the nursery is
 * ACTIVE and holds a live subscription. Downstream services never see a
 * subscription, a plan or a billing date, so they cannot re-derive the
 * rule and drift from it. (The monolith's README warned that duplicating
 * this predicate "is how you accidentally give the service away". Splitting
 * the services enforces that structurally.)
 *
 * `city` travels with it because inventory aggregates by city, and a
 * nursery that moves must be removed from its old city's totals.
 */
export interface SellabilityChangedData {
  nurseryId: string;
  city: string;
  sellable: boolean;
  reason: SellabilityReason;
  /**
   * Monotonic per nursery. Consumers apply an event only if its version
   * exceeds the one they hold, which makes delivery order irrelevant:
   * a late, stale event is discarded instead of undoing a newer one.
   */
  version: number;
}

/* --------------------------------------------- inventory.availability */

/**
 * The buyable quantity of one variant in one city, summed over every
 * sellable nursery there and net of reservations.
 *
 * This is a snapshot of a total, not a delta, so applying it twice is
 * harmless and a missed one is healed by the next.
 */
export interface AvailabilityChangedData {
  variantId: string;
  city: string;
  available: number;
  /** Nurseries contributing at least one unit. An ops figure, not a buyer one. */
  holders: number;
  /** Monotonic per (variantId, city). Same rule as above. */
  version: number;
}

/* ------------------------------------------------------------ type map */

export interface EventMap {
  [EventTypes.PartnerSellabilityChanged]: SellabilityChangedData;
  [EventTypes.InventoryAvailabilityChanged]: AvailabilityChangedData;
}

export type EventOf<T extends EventType> = EventEnvelope<T, EventMap[T]>;

/* ----------------------------------------------------------- guards */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

const isVersion = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;

/**
 * Runtime checks on payloads arriving off the bus.
 *
 * TypeScript types vanish at the process boundary: a producer on an older
 * build, a hand-published test event or a corrupted message all arrive as
 * `unknown`. Handlers narrow through these and so never operate on a shape
 * they merely hope is right.
 */
export function isSellabilityChanged(data: unknown): data is SellabilityChangedData {
  return (
    isObject(data) &&
    isUuid(data.nurseryId) &&
    isNonEmptyString(data.city) &&
    typeof data.sellable === "boolean" &&
    isNonEmptyString(data.reason) &&
    isVersion(data.version)
  );
}

export function isAvailabilityChanged(data: unknown): data is AvailabilityChangedData {
  return (
    isObject(data) &&
    isUuid(data.variantId) &&
    isNonEmptyString(data.city) &&
    isCount(data.available) &&
    isCount(data.holders) &&
    isVersion(data.version)
  );
}

/** True when `value` is shaped like an envelope. Does not inspect `data`. */
export function isEnvelope(value: unknown): value is EventEnvelope {
  return (
    isObject(value) &&
    isUuid(value.id) &&
    isNonEmptyString(value.type) &&
    isNonEmptyString(value.occurredAt) &&
    !Number.isNaN(Date.parse(String(value.occurredAt))) &&
    isNonEmptyString(value.producer) &&
    "data" in value
  );
}
