import { DELETE as appDelete } from "@/app/api/lifecycle/exceptions/[id]/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/lifecycle/exceptions/[id] — same parameters and response.
export const DELETE = withApiKey("lifecycle:write", appDelete);
