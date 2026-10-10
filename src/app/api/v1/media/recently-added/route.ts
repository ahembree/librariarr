import { GET as appGet } from "@/app/api/media/recently-added/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/recently-added — same parameters and response.
// `limit` is 1–50 there, so `limit=0` is an ordinary request, not a full
// listing.
export const GET = withApiKey("media:read", appGet, { limitZeroMeansAll: false });
