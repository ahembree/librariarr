import { GET as appGet } from "@/app/api/media/music/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/music — same parameters and response.
// `limit=0` returns the whole listing, so it is charged as one.
export const GET = withApiKey("media:read", appGet, { limitZeroMeansAll: true });
