import { GET as appGet } from "@/app/api/tools/sessions/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/tools/sessions — same parameters and response.
export const GET = withApiKey("streams:read", appGet);
