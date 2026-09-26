import { GET as appGet } from "@/app/api/media/music/albums/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/music/albums — same parameters and response.
export const GET = withApiKey("media:read", appGet);
