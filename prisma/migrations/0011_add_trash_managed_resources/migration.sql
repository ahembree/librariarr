-- Track which TRaSH Guides resources (custom formats, quality profiles,
-- quality-size definitions, naming schemes) the user has explicitly assigned
-- Librariarr to manage on a given Sonarr/Radarr instance. A row exists only
-- after the user opts in; no Arr write is ever made for a resource without a
-- managed row. The nullable instance FKs cascade, so deleting an instance
-- automatically removes its managed resources.

-- CreateTable
CREATE TABLE "TrashManagedResource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "sonarrInstanceId" TEXT,
    "radarrInstanceId" TEXT,
    "resourceType" TEXT NOT NULL,
    "trashId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "arrId" INTEGER,
    "selection" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrashManagedResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrashManagedResource_userId_idx" ON "TrashManagedResource"("userId");
CREATE INDEX "TrashManagedResource_sonarrInstanceId_idx" ON "TrashManagedResource"("sonarrInstanceId");
CREATE INDEX "TrashManagedResource_radarrInstanceId_idx" ON "TrashManagedResource"("radarrInstanceId");

-- One managed row per (user, instance, resource). Two composite uniques (one
-- per instance FK) because exactly one FK is populated per row; NULLs are
-- distinct in Postgres, so each constraint governs only the rows it names.
CREATE UNIQUE INDEX "TrashManagedResource_userId_sonarrInstanceId_resourceType_trashId_key" ON "TrashManagedResource"("userId", "sonarrInstanceId", "resourceType", "trashId");
CREATE UNIQUE INDEX "TrashManagedResource_userId_radarrInstanceId_resourceType_trashId_key" ON "TrashManagedResource"("userId", "radarrInstanceId", "resourceType", "trashId");

-- AddForeignKey
ALTER TABLE "TrashManagedResource"
    ADD CONSTRAINT "TrashManagedResource_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrashManagedResource"
    ADD CONSTRAINT "TrashManagedResource_sonarrInstanceId_fkey"
    FOREIGN KEY ("sonarrInstanceId") REFERENCES "SonarrInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrashManagedResource"
    ADD CONSTRAINT "TrashManagedResource_radarrInstanceId_fkey"
    FOREIGN KEY ("radarrInstanceId") REFERENCES "RadarrInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
