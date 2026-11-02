import { SONARR, instanceMetadataRoutes } from "@/lib/integrations/instance-routes";
import { loadSonarrMetadata } from "@/lib/integrations/instance-metadata";

// An instance's dropdown values, cached a minute, as every integration type answers it
// (src/lib/integrations/instance-routes.ts).
export const { GET } = instanceMetadataRoutes(SONARR, loadSonarrMetadata);
