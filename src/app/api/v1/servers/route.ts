import { GET as appGet } from "@/app/api/servers/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/servers — same parameters and response.
export const GET = withApiKey("servers:read", appGet);
