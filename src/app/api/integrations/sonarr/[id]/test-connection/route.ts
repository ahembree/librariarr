import { SONARR, instanceTestConnectionRoutes } from "@/lib/integrations/instance-routes";

// A saved instance's connection test, as every integration type answers it
// (src/lib/integrations/instance-routes.ts).
export const { POST } = instanceTestConnectionRoutes(SONARR);
