import { GET as appGet } from "@/app/api/media/series/grouped/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/series/grouped — same parameters and response.
export const GET = withApiKey("media:read", appGet);
