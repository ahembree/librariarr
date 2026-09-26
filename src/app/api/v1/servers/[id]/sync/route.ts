import { POST as appPost } from "@/app/api/servers/[id]/sync/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/servers/[id]/sync — same parameters and response.
export const POST = withApiKey("sync:write", appPost);
