# Event catalogue

The source of truth is `packages/contracts/src/events.ts`. Add an event there,
with its guard, before producing or consuming it.

All events travel in one envelope:

| Field | Meaning |
|---|---|
| `id` | uuid, created when the event is written to the producer's outbox. Broker de-duplication key (`Nats-Msg-Id`) and consumer idempotency key. |
| `type` | `<producer>.<noun>.<verb>.v<major>`; also the broker subject. |
| `occurredAt` | ISO-8601 UTC. When it happened, not when it was delivered. |
| `producer` | the service that wrote it |
| `correlationId?` | the request that caused it, tracing only |
| `data` | the payload below |

Stream `NURSERY_EVENTS`: subjects `partner.>`, `inventory.>`, `catalogue.>`;
file storage; 7-day retention; 1-hour duplicate window. Each consuming service
has one durable consumer named after itself; replicas share it.

## `partner.sellability.changed.v1`

Produced by **partner**. Consumed by **inventory**.

```json
{ "nurseryId": "uuid", "city": "Pune", "sellable": true,
  "reason": "subscription-renewed", "version": 7 }
```

- `sellable` = nursery ACTIVE and holds an ACTIVE/TRIALING subscription whose
  `currentPeriodEnd` is in the future.
- `version` is monotonic per nursery. Apply only if greater than the held one.
- `reason` is diagnostic (`initial`, `subscription-lapsed`,
  `subscription-renewed`, `status-changed`, `relocated`, `rebuild`). **Never
  branch on it.**
- `city` is included because inventory aggregates per city, and a nursery that
  moves must leave its old city's totals.
- Emitted only on a change (or on republish), never on every sweep.

## `inventory.availability.changed.v1`

Produced by **inventory**. Consumed by **catalogue**.

```json
{ "variantId": "uuid", "city": "Pune", "available": 37, "holders": 2, "version": 5 }
```

- A **snapshot of a total**, not a delta: applying it twice is harmless and a
  missed one is healed by the next.
- `available` = sum of `stock - reserved` over *sellable* nurseries in that
  city, active inventory rows only.
- `holders` = how many nurseries contribute at least one unit (an ops figure).
- `version` is monotonic per (variantId, city).
- An absent projection row means zero, so a never-stocked pair is never
  announced.

## Changing an event

- Additive, optional fields: safe within `v1`.
- Anything else is a **new type** (`…v2`) published alongside the old one until
  every consumer has moved. A silent edit lets an old consumer parse a new
  payload "successfully" and act on the wrong fields.

## Operating

- **A service was added late, or a projection was lost:** its new durable
  consumer replays the retained stream from the start. If history has aged
  past 7 days, re-announce: `POST /internal/sellability/republish` (partner),
  `POST /internal/availability/rebuild?force=true` (inventory).
- **Dead letters:** `SELECT * FROM dead_letters WHERE resolved_at IS NULL` in
  the consuming service's database. Fix the cause, then re-announce as above
  and set `resolved_at`.
