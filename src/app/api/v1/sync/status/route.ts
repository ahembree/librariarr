import { GET as appGet } from "@/app/api/sync/status/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { withoutServerInternals } from "@/lib/api-keys/trim-internals";

// Public API mirror of /api/sync/status — same parameters and response, with
// server addresses and machine ids omitted and each job's `error` sanitized
// (see `trim-internals.ts`).
export const GET = withApiKey("servers:read", withoutServerInternals(appGet));
