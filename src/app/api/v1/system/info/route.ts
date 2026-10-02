import { GET as appGet } from "@/app/api/system/info/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/system/info — same parameters and response.
export const GET = withApiKey("system:read", appGet);
