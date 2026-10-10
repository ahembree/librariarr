import { GET as appGet } from "@/app/api/media/history/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/history — same parameters and response.
export const GET = withApiKey("media:read", appGet);
