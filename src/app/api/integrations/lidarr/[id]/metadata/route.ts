import { LIDARR, instanceMetadataRoutes } from "@/lib/integrations/instance-routes";
import { loadLidarrMetadata } from "@/lib/integrations/instance-metadata";

// An instance's dropdown values, cached a minute, as every integration type answers it
// (src/lib/integrations/instance-routes.ts).
export const { GET } = instanceMetadataRoutes(LIDARR, loadLidarrMetadata);
