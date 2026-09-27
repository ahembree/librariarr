import { GET as appGet } from "@/app/api/media/[id]/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { withoutServerInternals } from "@/lib/api-keys/trim-internals";

// Public API mirror of /api/media/[id] — same parameters and response, minus
// the item's file path and its servers' addresses and machine ids (see
// `trim-internals.ts`).
export const GET = withApiKey("media:read", withoutServerInternals(appGet));
