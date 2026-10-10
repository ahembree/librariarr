import { GET as appGet } from "@/app/api/media/recently-added/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/recently-added — same parameters and response.
export const GET = withApiKey("media:read", appGet);
