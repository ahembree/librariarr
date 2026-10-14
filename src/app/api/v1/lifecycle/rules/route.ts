import { GET as appGet } from "@/app/api/lifecycle/rules/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { withoutServerInternals } from "@/lib/api-keys/trim-internals";

// Trimmed: each rule set row carries the owner's user id.
export const GET = withApiKey("lifecycle:read", withoutServerInternals(appGet));
