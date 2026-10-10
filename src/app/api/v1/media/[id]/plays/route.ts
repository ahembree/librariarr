import { GET as appGet } from "@/app/api/media/[id]/plays/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/[id]/plays — same parameters and response.
// `limit` is floored at 1 there, so `limit=0` is an ordinary page, not a
// full listing.
export const GET = withApiKey("media:read", appGet, { limitZeroMeansAll: false });
