import { SONARR, instanceRecycleBinRoutes } from "@/lib/integrations/instance-routes";

// Whether the app keeps deleted files in a recycle bin, as every integration type answers it
// (src/lib/integrations/instance-routes.ts).
export const { GET } = instanceRecycleBinRoutes(SONARR);
