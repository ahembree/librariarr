import { GET as appGet } from "@/app/api/lifecycle/actions/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/lifecycle/actions — same parameters and response.
export const GET = withApiKey("lifecycle:read", appGet);
