-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OfferCondition" AS ENUM ('PREMIUM', 'STANDARD', 'NURSERY_FRESH');

-- CreateTable
CREATE TABLE "inventory" (
    "id" UUID NOT NULL,
    "nurseryId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "condition" "OfferCondition" NOT NULL DEFAULT 'STANDARD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nursery_projection" (
    "nurseryId" UUID NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "sellable" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nursery_projection_pkey" PRIMARY KEY ("nurseryId")
);

-- CreateTable
CREATE TABLE "availability" (
    "variantId" UUID NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "available" INTEGER NOT NULL,
    "holders" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_pkey" PRIMARY KEY ("variantId","city")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "dead_letters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_variantId_isActive_idx" ON "inventory"("variantId", "isActive");

-- CreateIndex
CREATE INDEX "inventory_nurseryId_isActive_idx" ON "inventory"("nurseryId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_nurseryId_variantId_key" ON "inventory"("nurseryId", "variantId");

-- CreateIndex
CREATE INDEX "nursery_projection_city_sellable_idx" ON "nursery_projection"("city", "sellable");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_seq_key" ON "outbox"("seq");

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- CreateIndex
CREATE INDEX "dead_letters_resolved_at_idx" ON "dead_letters"("resolved_at");


-- Available stock can never go negative, whatever a caller does: the
-- application validates too, but this is the guard that cannot be skipped.
ALTER TABLE "inventory"
  ADD CONSTRAINT "inventory_quantities_check"
  CHECK (stock >= 0 AND reserved >= 0 AND reserved <= stock);

-- The relay only ever asks for unpublished rows, in order. A partial index
-- keeps that lookup tiny however much published history the table holds.
CREATE INDEX "outbox_unpublished_idx" ON "outbox" ("seq") WHERE "published_at" IS NULL;

-- Housekeeping: purge of old processed-event marks scans by age.
