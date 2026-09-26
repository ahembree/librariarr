import { DELETE as appDelete } from "@/app/api/lifecycle/exceptions/[id]/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/lifecycle/exceptions/[id] — same parameters and
// response. Removing an exception lifts a protection against deletion, so it
// needs the destructive scope (see ../route.ts).
export const DELETE = withApiKey("lifecycle:execute", appDelete);
