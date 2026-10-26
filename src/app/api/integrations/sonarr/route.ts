import { SONARR, instanceCollectionRoutes } from "@/lib/integrations/instance-routes";

// The instances list and create, as every integration type answers it
// (src/lib/integrations/instance-routes.ts).
export const { GET, POST } = instanceCollectionRoutes(SONARR);
