import { POST as appPost } from "@/app/api/lifecycle/actions/execute/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/lifecycle/actions/execute — same parameters and response.
export const POST = withApiKey("lifecycle:execute", appPost);
