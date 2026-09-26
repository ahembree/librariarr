import { GET as appGet, PUT as appPut } from "@/app/api/tools/maintenance/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/tools/maintenance — same parameters and response.
export const GET = withApiKey("streams:read", appGet);
export const PUT = withApiKey("streams:write", appPut);
