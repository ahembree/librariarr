import { GET as appGet } from "@/app/api/media/[id]/plays/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/media/[id]/plays — same parameters and response.
export const GET = withApiKey("media:read", appGet);
