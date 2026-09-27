import { POST as appPost } from "@/app/api/sync/cancel/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/sync/cancel — same parameters and response.
export const POST = withApiKey("sync:write", appPost);
