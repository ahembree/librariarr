import { GET as appGet } from "@/app/api/lifecycle/actions/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { withoutServerInternals } from "@/lib/api-keys/trim-internals";

// Public API mirror of /api/lifecycle/actions — same parameters and response,
// with each action's `error` passed through `sanitizeErrorDetail`: rows written
// before errors were sanitized at the source still hold raw Arr and network
// text (internal addresses, file paths). It has no paging, so each read is
// charged as a full listing.
export const GET = withApiKey("lifecycle:read", withoutServerInternals(appGet), { fullListing: true });
