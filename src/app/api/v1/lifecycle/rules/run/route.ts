import { POST as appPost } from "@/app/api/lifecycle/rules/run/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/lifecycle/rules/run — same parameters and response.
export const POST = withApiKey("lifecycle:write", appPost);
