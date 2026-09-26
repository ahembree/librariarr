import { GET as appGet } from "@/app/api/media/music/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/music — same parameters and response.
export const GET = withApiKey("media:read", appGet);
