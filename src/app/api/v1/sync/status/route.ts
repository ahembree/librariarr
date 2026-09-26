import { GET as appGet } from "@/app/api/sync/status/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/sync/status — same parameters and response.
export const GET = withApiKey("servers:read", appGet);
