# Architecture

## What the services are, and why those lines

Boundaries follow who *owns a decision*, not which tables are near each other.

| Service | Owns | Decides |
|---|---|---|
| **partner** | nurseries, plans, subscriptions, invoices, members | whether a nursery may currently sell |
| **inventory** | stock per (nursery, variant) | how many of a variant can be bought in a city |
| **catalogue** | plants, variants, categories, collections, per-city prices | what exists and what it costs |
| **gateway** | nothing | which paths are public |

The first row matters most. In the monolith, "does this nursery's stock count?"
was a SQL predicate (nursery ACTIVE and an unexpired ACTIVE/TRIALING
subscription) written inside the catalogue query. It is the rule that makes
the subscription fee enforceable, so duplicating it is how it silently
drifts. Now it exists once, in `partner`
(`services/partner/src/sellability/sellability.logic.ts`), and the answer
travels as a fact: `sellable: true|false`. No other service ever sees a
subscription.

## How data moves

```
partner ──partner.sellability.changed.v1──▶ inventory ──inventory.availability.changed.v1──▶ catalogue
 (rule)        {nurseryId, city, sellable, version}      {variantId, city, available, holders, version}
```

Each hop **copies** what it needs into its own database (a projection), so
every read is answered locally and no request ever fans out across services.
That is why the storefront still answers when inventory or the broker is down.

The alternative, composing at the gateway (fetch plants from catalogue, stock
from inventory, merge), cannot paginate or sort by price or stock, because
those need the joined data to exist in one place. Projections can.

### Making events safe

Delivery is **at-least-once and unordered**. Correctness comes from four small
mechanisms, all in `packages/platform`:

1. **Transactional outbox.** An event row is inserted in the *same transaction*
   as the change it announces. A relay publishes it afterwards and retries
   forever. Publish-then-write, or write-then-publish, each leave a crash window
   that loses or invents an event; this closes both.
2. **Broker de-duplication.** The relay sends the event id as `Nats-Msg-Id`, so a
   relay that crashes after publishing but before marking the row published
   does not produce a second copy (within the stream's 1-hour window).
3. **Idempotent consumers.** "Have I processed this id" is recorded in the same
   transaction as the handler's own writes. If the handler fails the mark rolls
   back and the retry counts as a first attempt; if it commits, redelivery is
   skipped.
4. **Versions.** Each fact carries a per-key monotonic version
   (nursery; variant+city). A consumer applies an event only if it is newer than
   what it holds, so a late straggler cannot undo a newer fact. This is what
   makes *ordering* irrelevant; the outbox's sequence number is assigned at
   insert, not commit, and the bus makes no ordering promise across consumers.

After eight failed deliveries a handler gives up, writes the event to
`dead_letters`, and acknowledges it, so one poison message cannot block the
stream. Someone has to look at that table.

### The one behaviour change

The monolith evaluated subscription expiry **at query time**: the moment
`currentPeriodEnd` passed, the next page view hid that nursery's stock. A
projection cannot do that, because nothing *happens* when a clock passes a
date. So partner runs a sweep (`SELLABILITY_SWEEP_SECONDS`, default 60s) that
finds nurseries whose answer changed and announces it. A lapsed nursery can
therefore keep selling for up to a minute (plus event latency, typically
milliseconds). Tune the interval, or accept the lag; it is not zero.

Related: **the listing is now a hint, not a promise.** Stock shown can be a
moment stale. The authoritative check belongs at order time, under a row lock,
in the service that owns the stock. No ordering service exists yet, so that
check is still to be built; see "Not built".

## Where every monolith model went

The monolith's `schema.prisma` declares 29 models, but only the catalogue
module has application code (`src/` holds catalogue, config, health, prisma).
So "migrated" means schema plus behaviour for catalogue, and schema only for
the rest.

| Monolith model | Now | Notes |
|---|---|---|
| Category, Plant, PlantImage, Collection, CollectionPlant | **catalogue** | unchanged |
| PlantVariant, VariantCityPrice | **catalogue** | unchanged; admin-owned prices |
| Nursery, NurseryImage | **partner** | PostGIS `location` kept (generated column + GiST index) |
| NurseryMember | **partner** | `userId` is a plain id, no FK (identity is another service) |
| Plan, Subscription, Invoice | **partner** | unchanged |
| Inventory | **inventory** | no FKs to nursery or variant; adds CHECK `0 <= reserved <= stock` |
| *(new)* NurserySellability | partner | the announced sellability + version |
| *(new)* NurseryProjection | inventory | copy of sellability |
| *(new)* Availability | inventory | per (variant, city) totals + version |
| *(new)* VariantAvailability | catalogue | copy of availability |
| *(new)* Outbox / ProcessedEvent / DeadLetter | each, as needed | partner: outbox; inventory: all; catalogue: processed + dead letters |
| User, OtpChallenge, RefreshToken, PushToken | *not migrated* (future **identity**) | schema only in the monolith |
| Address, Cart, CartItem, Order, OrderItem, Payment, Payout, DeliveryRate, IdempotencyKey | *not migrated* (future **ordering/payments**) | schema only in the monolith |
| Enquiry, AuditLog | *not migrated* | schema only in the monolith |

## The gateway

An explicit allow-list (`gateway/src/routes.ts`), not a pass-through. A new
route on a service is private until someone adds it there. Read-only for now:
every public route is GET/HEAD. It also: sanitises and propagates
`x-request-id` (only a conservative shape is trusted; one id follows a request
through every service), strips any client-supplied `x-internal-token`, applies
CORS and a per-IP rate limit, maps upstream failures to 502/504 with a clean
body (no hostnames or SQL), and aggregates health. `/health` is `degraded`, not
failing, when some services are down; only "nothing answers" is 503.
`/health/live` has no dependencies.

## Data ownership and databases

One Postgres server in dev, **one database and one role per service**
(`docker/postgres/init`). `CONNECT` is revoked from `PUBLIC`, and this was
checked: `svc_inventory` is refused on `nursery_partner`. Splitting the
databases is what actually enforces the boundary; separate processes sharing
one database are a monolith with extra network hops.

Ids that must agree across databases without a call (a seeded nursery in
inventory, a variant in inventory and catalogue) are UUIDv5 of their natural
key. Production rows use random UUIDs; the shared derivation is for seeds only.

## Security posture

- `/internal/*` is unreachable from outside (gateway allow-list) **and**
  requires `x-internal-token` (constant-time compare).
- That token is shared by all services. It proves "something inside the
  network", not *which* service; a compromised service can impersonate any
  other. Replace it with mTLS or per-service signed tokens before this holds
  anything sensitive. This is the most important thing here to harden.
- Money is integer paise throughout. All SQL takes bound parameters; raw SQL
  is static text.
- No secrets are committed; `.env` is git-ignored and every `.env.example`
  contains dev-only values. `INTERNAL_API_TOKEN` is validated at boot (>= 16
  chars).

## Not built

- **identity, ordering, payments, notifications** services, and everything
  that needs them: auth, carts, orders, payouts, enquiries.
- **The authoritative stock check at order time** (reservation under a row
  lock), which the eventually-consistent listing depends on.
- **Authenticated nursery-facing stock endpoints.** Stock is currently set via
  `PUT /internal/stock/...` and the seed.
- **Gateway auth** (JWT), write routes, and an admin API for catalogue edits:
  the catalogue has no write API at all yet.
- **Integration tests** against a real database (see README, "Quality gates").
- **Deployment.** Docker Compose runs only the infrastructure; the services run
  from `node dist/main.js`. No Dockerfiles, orchestration or CI.
- **Production NATS** (replication, auth, TLS) and a real secret store.
