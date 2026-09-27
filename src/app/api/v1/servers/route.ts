import { GET as appGet } from "@/app/api/servers/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { withoutServerInternals } from "@/lib/api-keys/trim-internals";

// Public API mirror of /api/servers — same parameters and response, minus
// each server's address, machine id and owner (see `trim-internals.ts`).
export const GET = withApiKey("servers:read", withoutServerInternals(appGet));
