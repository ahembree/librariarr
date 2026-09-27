import { GET as appGet } from "@/app/api/lifecycle/rules/matches/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { withoutServerInternals } from "@/lib/api-keys/trim-internals";

// Public API mirror of /api/lifecycle/rules/matches — same parameters and
// response, minus the file path each match's stored item snapshot carries and
// its servers' addresses (see `trim-internals.ts`).
export const GET = withApiKey("lifecycle:read", withoutServerInternals(appGet));
