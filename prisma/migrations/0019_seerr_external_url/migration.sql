-- Browser-facing base URL for "Open in Seerr" links, like the Sonarr/Radarr/Lidarr
-- instances have. NULL falls back to the connection URL.
ALTER TABLE "SeerrInstance" ADD COLUMN "externalUrl" TEXT;
