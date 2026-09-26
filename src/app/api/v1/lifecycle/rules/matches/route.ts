import { GET as appGet } from "@/app/api/lifecycle/rules/matches/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/lifecycle/rules/matches — same parameters and response.
export const GET = withApiKey("lifecycle:read", appGet);
