import { SEERR, instanceItemRoutes } from "@/lib/integrations/instance-routes";

// An instance's edit and delete, as every integration type answers it
// (src/lib/integrations/instance-routes.ts).
export const { PUT, DELETE } = instanceItemRoutes(SEERR);
