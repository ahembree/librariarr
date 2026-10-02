import { GET as appGet } from "@/app/api/tools/sessions/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { withoutServerInternals } from "@/lib/api-keys/trim-internals";

// Public API mirror of /api/tools/sessions — same parameters and response,
// minus the path of the file each stream plays (see `trim-internals.ts`).
export const GET = withApiKey("streams:read", withoutServerInternals(appGet));
