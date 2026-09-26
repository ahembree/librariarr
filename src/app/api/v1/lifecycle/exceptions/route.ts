import { GET as appGet, POST as appPost, DELETE as appDelete } from "@/app/api/lifecycle/exceptions/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/lifecycle/exceptions — same parameters and response.
export const GET = withApiKey("lifecycle:read", appGet);
// Adding an exception only ever protects media.
export const POST = withApiKey("lifecycle:write", appPost);
// Removing one lifts that protection, after which the rules can match the item
// and the executor delete it — so it needs the destructive scope, not
// `lifecycle:write`, or that scope could get protected media deleted.
export const DELETE = withApiKey("lifecycle:execute", appDelete);
