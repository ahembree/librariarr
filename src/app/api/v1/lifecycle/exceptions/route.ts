import { GET as appGet, POST as appPost, DELETE as appDelete } from "@/app/api/lifecycle/exceptions/route";
import { withApiKey } from "@/lib/api-keys/guard";

// Public API mirror of /api/lifecycle/exceptions — same parameters and response.
export const GET = withApiKey("lifecycle:read", appGet);
export const POST = withApiKey("lifecycle:write", appPost);
export const DELETE = withApiKey("lifecycle:write", appDelete);
