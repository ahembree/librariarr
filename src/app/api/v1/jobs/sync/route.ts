import { withApiKey } from "@/lib/api-keys/guard";
import { runJobForApiKey } from "@/lib/api-keys/run-job";

// Queue a sync of every enabled server now — the Settings "Run now" button.
export const POST = withApiKey("sync:write", () => runJobForApiKey("sync"));
