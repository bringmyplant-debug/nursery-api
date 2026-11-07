-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "NurseryStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "NurseryMemberRole" AS ENUM ('OWNER', 'MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('SEED', 'SAPLING', 'CANOPY');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- CreateTable
CREATE TABLE "nurseries" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "legalName" VARCHAR(200),
    "status" "NurseryStatus" NOT NULL DEFAULT 'PENDING',
    "city" VARCHAR(80) NOT NULL,
    "area" VARCHAR(120),
    "addressLine" VARCHAR(400),
    "pincode" VARCHAR(10),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    -- GENERATED from latitude/longitude, so ordinary writes keep the geometry
    -- correct with no second source of truth and no trigger to forget.
    -- geography (not geometry): distances come back in metres on a sphere, so
    -- ST_DWithin takes a radius in metres with no projection work.
    "location" geography(Point, 4326) GENERATED ALWAYS AS (
        CASE
            WHEN "longitude" IS NULL OR "latitude" IS NULL THEN NULL
            ELSE ST_SetSRID(ST_MakePoint("longitude"::double precision, "latitude"::double precision), 4326)::geography
        END
    ) STORED,
    "phone" VARCHAR(20) NOT NULL,
    "whatsapp" VARCHAR(20),
    "email" VARCHAR(255),
    "bio" TEXT,
    "hours" VARCHAR(200),
    "deliveryRadiusKm" INTEGER NOT NULL DEFAULT 10,
    "specialities" TEXT[],
    "since" INTEGER,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "commissionBps" INTEGER NOT NULL DEFAULT 800,
    "rating" DECIMAL(2,1),
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nurseries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nursery_images" (
    "id" UUID NOT NULL,
    "nurseryId" UUID NOT NULL,
    "url" VARCHAR(600) NOT NULL,
    "alt" VARCHAR(300),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nursery_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nursery_members" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "nurseryId" UUID NOT NULL,
    "role" "NurseryMemberRole" NOT NULL DEFAULT 'OWNER',
    "invitedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nursery_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "tier" "PlanTier" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "blurb" VARCHAR(300),
    "monthlyPaise" INTEGER NOT NULL,
    "annualPaise" INTEGER NOT NULL,
    "listingLimit" INTEGER,
    "features" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "nurseryId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "period" "BillingPeriod" NOT NULL DEFAULT 'MONTHLY',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "externalRef" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "taxPaise" INTEGER NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "externalRef" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nursery_sellability" (
    "nurseryId" UUID NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "sellable" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nursery_sellability_pkey" PRIMARY KEY ("nurseryId")
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

-- CreateIndex
CREATE UNIQUE INDEX "nurseries_slug_key" ON "nurseries"("slug");

-- CreateIndex
CREATE INDEX "nurseries_status_city_idx" ON "nurseries"("status", "city");

-- CreateIndex
CREATE INDEX "nursery_images_nurseryId_sortOrder_idx" ON "nursery_images"("nurseryId", "sortOrder");

-- CreateIndex
CREATE INDEX "nursery_members_nurseryId_idx" ON "nursery_members"("nurseryId");

-- CreateIndex
CREATE UNIQUE INDEX "nursery_members_userId_nurseryId_key" ON "nursery_members"("userId", "nurseryId");

-- CreateIndex
CREATE UNIQUE INDEX "plans_tier_key" ON "plans"("tier");

-- CreateIndex
CREATE INDEX "subscriptions_nurseryId_status_idx" ON "subscriptions"("nurseryId", "status");

-- CreateIndex
CREATE INDEX "subscriptions_status_currentPeriodEnd_idx" ON "subscriptions"("status", "currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_subscriptionId_status_idx" ON "invoices"("subscriptionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_seq_key" ON "outbox"("seq");

-- AddForeignKey
ALTER TABLE "nursery_images" ADD CONSTRAINT "nursery_images_nurseryId_fkey" FOREIGN KEY ("nurseryId") REFERENCES "nurseries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursery_members" ADD CONSTRAINT "nursery_members_nurseryId_fkey" FOREIGN KEY ("nurseryId") REFERENCES "nurseries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_nurseryId_fkey" FOREIGN KEY ("nurseryId") REFERENCES "nurseries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursery_sellability" ADD CONSTRAINT "nursery_sellability_nurseryId_fkey" FOREIGN KEY ("nurseryId") REFERENCES "nurseries"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- GiST is the index type PostGIS radius and nearest-neighbour queries can use;
-- a btree on lat/lng cannot serve ST_DWithin.
CREATE INDEX "nurseries_location_idx" ON "nurseries" USING GIST ("location");

-- The relay only ever asks for unpublished rows, in order. A partial index
-- keeps that lookup tiny however much published history the table holds.
CREATE INDEX "outbox_unpublished_idx" ON "outbox" ("seq") WHERE "published_at" IS NULL;
