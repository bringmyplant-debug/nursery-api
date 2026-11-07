-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LightNeed" AS ENUM ('LOW', 'BRIGHT_INDIRECT', 'FULL_SUN');

-- CreateEnum
CREATE TYPE "WaterNeed" AS ENUM ('LOW', 'MODERATE', 'HIGH');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MODERATE', 'EXPERT');

-- CreateEnum
CREATE TYPE "Placement" AS ENUM ('INDOOR', 'OUTDOOR', 'BOTH');

-- CreateEnum
CREATE TYPE "Season" AS ENUM ('SUMMER', 'WINTER', 'MONSOON', 'ALL_SEASON');

-- CreateEnum
CREATE TYPE "PlantStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "blurb" VARCHAR(300),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "commonName" VARCHAR(160) NOT NULL,
    "botanicalName" VARCHAR(160) NOT NULL,
    "family" VARCHAR(120),
    "categoryId" UUID NOT NULL,
    "status" "PlantStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" VARCHAR(320) NOT NULL,
    "description" TEXT NOT NULL,
    "lightNeed" "LightNeed" NOT NULL,
    "waterNeed" "WaterNeed" NOT NULL,
    "waterEveryDays" INTEGER NOT NULL,
    "humidity" VARCHAR(120),
    "temperature" VARCHAR(120),
    "soil" VARCHAR(200),
    "fertiliser" VARCHAR(200),
    "petSafe" BOOLEAN NOT NULL DEFAULT false,
    "airPurifying" BOOLEAN NOT NULL DEFAULT false,
    "lowMaintenance" BOOLEAN NOT NULL DEFAULT false,
    "flowering" BOOLEAN NOT NULL DEFAULT false,
    "placement" "Placement" NOT NULL DEFAULT 'INDOOR',
    "difficulty" "Difficulty" NOT NULL,
    "season" "Season" NOT NULL DEFAULT 'ALL_SEASON',
    "matureSize" VARCHAR(120),
    "growthRate" VARCHAR(60),
    "tags" TEXT[],
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_images" (
    "id" UUID NOT NULL,
    "plantId" UUID NOT NULL,
    "url" VARCHAR(600) NOT NULL,
    "alt" VARCHAR(300),
    "credit" VARCHAR(200),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plant_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "tagline" VARCHAR(200),
    "description" TEXT,
    "imageUrl" VARCHAR(600),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_plants" (
    "collectionId" UUID NOT NULL,
    "plantId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_plants_pkey" PRIMARY KEY ("collectionId","plantId")
);

-- CreateTable
CREATE TABLE "plant_variants" (
    "id" UUID NOT NULL,
    "plantId" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "potSize" VARCHAR(20) NOT NULL,
    "potMaterial" VARCHAR(60),
    "heightCm" INTEGER,
    "basePricePaise" INTEGER NOT NULL,
    "baseMrpPaise" INTEGER,
    "hsnCode" VARCHAR(12),
    "taxRateBps" INTEGER NOT NULL DEFAULT 0,
    "weightGrams" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plant_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_city_prices" (
    "id" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "pricePaise" INTEGER NOT NULL,
    "mrpPaise" INTEGER,
    "note" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_city_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_availability" (
    "variantId" UUID NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "available" INTEGER NOT NULL,
    "holders" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_availability_pkey" PRIMARY KEY ("variantId","city")
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
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_isActive_sortOrder_idx" ON "categories"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "plants_slug_key" ON "plants"("slug");

-- CreateIndex
CREATE INDEX "plants_status_publishedAt_idx" ON "plants"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "plants_status_season_idx" ON "plants"("status", "season");

-- CreateIndex
CREATE INDEX "plants_categoryId_idx" ON "plants"("categoryId");

-- CreateIndex
CREATE INDEX "plants_lightNeed_idx" ON "plants"("lightNeed");

-- CreateIndex
CREATE INDEX "plants_difficulty_idx" ON "plants"("difficulty");

-- CreateIndex
CREATE INDEX "plants_petSafe_idx" ON "plants"("petSafe");

-- CreateIndex
CREATE INDEX "plants_tags_idx" ON "plants" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "plant_images_plantId_sortOrder_idx" ON "plant_images"("plantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "collections_slug_key" ON "collections"("slug");

-- CreateIndex
CREATE INDEX "collections_isActive_sortOrder_idx" ON "collections"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "collection_plants_plantId_idx" ON "collection_plants"("plantId");

-- CreateIndex
CREATE UNIQUE INDEX "plant_variants_sku_key" ON "plant_variants"("sku");

-- CreateIndex
CREATE INDEX "plant_variants_plantId_isActive_idx" ON "plant_variants"("plantId", "isActive");

-- CreateIndex
CREATE INDEX "plant_variants_basePricePaise_idx" ON "plant_variants"("basePricePaise");

-- CreateIndex
CREATE UNIQUE INDEX "plant_variants_plantId_potSize_key" ON "plant_variants"("plantId", "potSize");

-- CreateIndex
CREATE INDEX "variant_city_prices_city_idx" ON "variant_city_prices"("city");

-- CreateIndex
CREATE UNIQUE INDEX "variant_city_prices_variantId_city_key" ON "variant_city_prices"("variantId", "city");

-- CreateIndex
CREATE INDEX "variant_availability_city_idx" ON "variant_availability"("city");

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- CreateIndex
CREATE INDEX "dead_letters_resolved_at_idx" ON "dead_letters"("resolved_at");

-- AddForeignKey
ALTER TABLE "plants" ADD CONSTRAINT "plants_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_images" ADD CONSTRAINT "plant_images_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_plants" ADD CONSTRAINT "collection_plants_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_plants" ADD CONSTRAINT "collection_plants_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_variants" ADD CONSTRAINT "plant_variants_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_city_prices" ADD CONSTRAINT "variant_city_prices_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "plant_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

