import { POST as appPost } from "@/app/api/tools/sessions/terminate/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/tools/sessions/terminate — same parameters and response.
export const POST = withApiKey("streams:write", appPost);
