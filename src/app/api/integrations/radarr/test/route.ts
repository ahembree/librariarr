import { RADARR, instanceTestRoutes } from "@/lib/integrations/instance-routes";

// An unsaved URL and key's connection test, as every integration type answers it
// (src/lib/integrations/instance-routes.ts).
export const { POST } = instanceTestRoutes(RADARR);
