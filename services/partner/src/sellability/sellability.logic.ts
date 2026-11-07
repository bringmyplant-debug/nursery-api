import type { SellabilityReason } from "@nursery-co/contracts";

/** What the database says about one nursery right now. */
export interface Observation {
  nurseryId: string;
  city: string;
  /** The nursery's own status is ACTIVE. */
  active: boolean;
  /** It holds a subscription that is ACTIVE or TRIALING and not past its end date. */
  liveSubscription: boolean;
}

/** What this service last announced. */
export interface StoredState {
  city: string;
  sellable: boolean;
  version: number;
}

export interface Transition {
  sellable: boolean;
  city: string;
  version: number;
  reason: SellabilityReason;
}

/**
 * The platform's rule for whether a nursery's stock may be sold.
 *
 * This is the only place it is written down. Other services receive the
 * answer in an event and never see a subscription, so none of them can
 * grow a second, slightly different copy of it.
 */
export const isSellable = (o: Pick<Observation, "active" | "liveSubscription">): boolean =>
  o.active && o.liveSubscription;

/**
 * Compare reality with what was last announced and decide whether a new
 * announcement is due.
 *
 * Returns null when nothing changed: an event per reconcile would make
 * every sweep noisy and every consumer redo work for nothing. Versions
 * only move on a real change, so a consumer holding version N knows there
 * is nothing between N and the next event it receives.
 *
 * `reason` is diagnostic. It is chosen from what is observable now, so
 * when a status change and a subscription change land together it reports
 * the more specific one; consumers must act on `sellable` alone.
 */
export function decideTransition(prev: StoredState | null, observed: Observation): Transition | null {
  const sellable = isSellable(observed);

  if (prev === null) {
    return { sellable, city: observed.city, version: 1, reason: "initial" };
  }
  if (prev.sellable === sellable && prev.city === observed.city) return null;

  return {
    sellable,
    city: observed.city,
    version: prev.version + 1,
    reason: reasonFor(prev, observed, sellable),
  };
}

/**
 * Re-announce the current state unconditionally, with a fresh version so
 * every consumer — which ignores anything not newer — accepts it.
 *
 * For when a downstream service was added after the original events
 * aged out of the bus, or lost its projection.
 */
export function republishTransition(prev: StoredState | null, observed: Observation): Transition {
  return {
    sellable: isSellable(observed),
    city: observed.city,
    version: (prev?.version ?? 0) + 1,
    reason: "rebuild",
  };
}

function reasonFor(prev: StoredState, observed: Observation, sellable: boolean): SellabilityReason {
  if (prev.sellable === sellable) return "relocated";
  if (!observed.active) return "status-changed";
  return sellable ? "subscription-renewed" : "subscription-lapsed";
}
