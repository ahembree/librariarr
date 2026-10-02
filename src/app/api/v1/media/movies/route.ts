import { GET as appGet } from "@/app/api/media/movies/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/movies — same parameters and response.
export const GET = withApiKey("media:read", appGet);
