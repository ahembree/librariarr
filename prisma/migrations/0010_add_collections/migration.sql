-- Introduce reusable Collection definitions so multiple lifecycle rule sets can
-- sync into ("merge") a single Plex collection. The collection-level settings
-- (sort order, sort title, home-screen / recommended visibility) move off the
-- per-rule-set inline columns onto the shared Collection row.

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LibraryType" NOT NULL,
    "sortName" TEXT,
    "homeScreen" BOOLEAN NOT NULL DEFAULT false,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "sort" TEXT NOT NULL DEFAULT 'ALPHABETICAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- One collection per (user, type, name); two rule sets that targeted the same
-- name+type are about to share this single row.
CREATE UNIQUE INDEX "Collection_userId_type_name_key" ON "Collection"("userId", "type", "name");
CREATE INDEX "Collection_userId_idx" ON "Collection"("userId");

ALTER TABLE "Collection"
    ADD CONSTRAINT "Collection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Link rule sets to their collection.
ALTER TABLE "RuleSet" ADD COLUMN "collectionId" TEXT;
CREATE INDEX "RuleSet_collectionId_idx" ON "RuleSet"("collectionId");
ALTER TABLE "RuleSet"
    ADD CONSTRAINT "RuleSet_collectionId_fkey"
    FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: create one Collection per distinct (userId, type, collectionName)
-- among rule sets that had collection sync enabled. When multiple rule sets
-- shared the same name+type, the settings from the most-recently-updated one
-- win (DISTINCT ON ... ORDER BY updatedAt DESC) and the rows auto-merge into a
-- single shared collection.
INSERT INTO "Collection" ("id", "userId", "name", "type", "sortName", "homeScreen", "recommended", "sort", "createdAt", "updatedAt")
SELECT DISTINCT ON ("userId", "type", "collectionName")
    gen_random_uuid()::text,
    "userId",
    "collectionName",
    "type",
    "collectionSortName",
    "collectionHomeScreen",
    "collectionRecommended",
    "collectionSort",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "RuleSet"
WHERE "collectionEnabled" = true AND "collectionName" IS NOT NULL
ORDER BY "userId", "type", "collectionName", "updatedAt" DESC;

-- Point each contributing rule set at its (now shared) collection.
UPDATE "RuleSet" rs
SET "collectionId" = c."id"
FROM "Collection" c
WHERE rs."collectionEnabled" = true
  AND rs."collectionName" IS NOT NULL
  AND c."userId" = rs."userId"
  AND c."type" = rs."type"
  AND c."name" = rs."collectionName";

-- Drop the now-migrated inline columns.
ALTER TABLE "RuleSet" DROP COLUMN "collectionEnabled";
ALTER TABLE "RuleSet" DROP COLUMN "collectionName";
ALTER TABLE "RuleSet" DROP COLUMN "collectionSortName";
ALTER TABLE "RuleSet" DROP COLUMN "collectionHomeScreen";
ALTER TABLE "RuleSet" DROP COLUMN "collectionRecommended";
ALTER TABLE "RuleSet" DROP COLUMN "collectionSort";
