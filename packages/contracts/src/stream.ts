/**
 * Broker topology, shared so that every service creates the same stream.
 *
 * Each service ensures the stream exists when it starts, so the order in
 * which services boot does not matter. That only works if they all ask for
 * the *same* configuration — hence one definition, here.
 */

export const STREAM_NAME = "NURSERY_EVENTS";

/**
 * One subject root per producing service. `>` matches every deeper token,
 * so `inventory.>` captures `inventory.availability.changed.v1` and
 * whatever that service publishes next, with no change here.
 */
export const STREAM_SUBJECTS = ["partner.>", "inventory.>", "catalogue.>"] as const;

/** Seven days. Long enough to recover from a weekend outage by replay. */
export const STREAM_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * The broker drops a second message with an already-seen id inside this
 * window. It is the last line of defence against the outbox relay
 * publishing the same event twice after a crash.
 */
export const STREAM_DUPLICATE_WINDOW_SECONDS = 60 * 60;
