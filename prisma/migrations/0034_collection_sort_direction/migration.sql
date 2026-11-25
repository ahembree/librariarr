-- A Plex collection's sort direction. Existing collections keep their
-- ascending order (the only direction before this column).
ALTER TABLE "Collection" ADD COLUMN "sortDirection" TEXT NOT NULL DEFAULT 'asc';
