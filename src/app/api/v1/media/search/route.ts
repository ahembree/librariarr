import { GET as appGet } from "@/app/api/media/search/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/search — same parameters and response.
export const GET = withApiKey("media:read", appGet);
