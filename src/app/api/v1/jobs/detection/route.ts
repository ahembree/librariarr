import { withApiKey } from "@/lib/api-keys/guard";
import { runJobForApiKey } from "@/lib/api-keys/run-job";

// Queue lifecycle detection now — the Settings "Run now" button.
export const POST = withApiKey("lifecycle:write", () => runJobForApiKey("detection"));
