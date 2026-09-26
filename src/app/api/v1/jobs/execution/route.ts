import { withApiKey } from "@/lib/api-keys/guard";
import { runJobForApiKey } from "@/lib/api-keys/run-job";

// Queue lifecycle execution now — the Settings "Run now" button. Runs every
// due pending action, which can delete media; hence its own scope.
export const POST = withApiKey("lifecycle:execute", () => runJobForApiKey("execution"));
