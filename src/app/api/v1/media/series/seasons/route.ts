import { GET as appGet } from "@/app/api/media/series/seasons/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/series/seasons — same parameters and response.
export const GET = withApiKey("media:read", appGet);
