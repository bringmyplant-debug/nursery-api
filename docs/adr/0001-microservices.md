# ADR 0001: Split the backend into services

Status: accepted (the product owner asked for it). Date: 2026-11-08.

## Context

The backend was one NestJS application over one Postgres database
(`nursery-web/apps/api`). Its only built module is the catalogue; the rest of
the schema (identity, cart, orders, payments, payouts) is designed but
unwritten. The request was to move to a microservices architecture in a new
`nursery-api` folder.

## Decision

Three services plus a gateway, each with its own database, talking through
NATS JetStream events:

- **partner**: nurseries, plans, subscriptions. Owns the sellability rule.
- **inventory**: stock, and per-city buyable totals.
- **catalogue**: plants, variants, prices; serves the storefront.
- **gateway**: the single public entry point.

Identity, ordering, payments and notifications are expected to follow as
services when their code is written.

Notable choices:

- **Event-carried projections, not request-time composition.** Services copy
  the facts they need and read locally. Cost: eventual consistency.
- **Transactional outbox + idempotent consumers + versions**, not
  "publish after commit". Cost: more machinery (see ARCHITECTURE.md).
- **NATS JetStream**, not Kafka or SQS: one small binary to run locally,
  durable streams, replay for a newly added service, and an `EventBus`
  interface (`packages/platform`) so the broker is swappable by writing one
  adapter.
- **Database per service**, enforced by roles, not by convention.
- **Hand-rolled shared package, small on purpose.** `contracts` holds only
  event types and guards. `platform` holds plumbing, never domain rules.

## Consequences

What this buys: fault isolation (the storefront kept serving through an
inventory outage and a broker outage, verified), independent deployment and
scaling, and a rule (sellability) that lives in exactly one place.

What it costs, plainly:

- **Four processes, three databases and a broker** to run, deploy, monitor and
  debug where there was one. Every feature that crosses a boundary is now a
  contract change plus an event, not a join.
- **Eventual consistency**, visible to users as slightly stale stock and in
  one behaviour change: subscription expiry now takes effect on the next
  sweep (default up to 60s) instead of instantly.
- **A distributed-systems failure surface** that did not exist: duplicate and
  reordered events, a stuck dead-letter table, projections that drift. The
  mechanisms for these are built and tested at the unit level; they still need
  operating.
- **A real coordination problem ahead.** Ordering must reserve stock held by
  another service, which means either a synchronous call with a lock or a
  saga with compensation. Neither is built; the current listing is explicitly a
  hint until one is.

## A concern worth recording

For a team this size and a product with one built module, a modular monolith
(separate modules, one deployable, one database, in-process events) would have
delivered most of the isolation benefits at a fraction of the operational
cost, and could still be split later along the same lines. The split was
requested and has been done; the seams chosen here (partner / inventory /
catalogue) are the ones a modular monolith would also have used, so nothing is
lost if the operational cost proves too high and services are folded back
together behind the same event contracts.

## Rejected alternatives

- **Composition at the gateway.** Cannot paginate or sort across services.
- **Shared database, separate services.** Keeps every coupling and adds the
  network.
- **Synchronous service-to-service reads on each request.** Couples storefront
  availability to the slowest service and multiplies latency.
- **Kafka.** Heavier than this needs today; the `EventBus` seam keeps the door
  open.

## Revisit when

- The ordering service is designed (the stock-reservation question).
- Operating cost, or event-debugging time, visibly exceeds the isolation won.
- The internal shared token is replaced (mTLS or per-service tokens).
