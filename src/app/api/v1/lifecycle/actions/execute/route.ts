import { NextRequest } from "next/server";
import { POST as appPost } from "@/app/api/lifecycle/actions/execute/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { validateRequest, apiActionExecuteSchema } from "@/lib/validation";

// Public API mirror of /api/lifecycle/actions/execute — same response. Takes
// less than the app's route (see `apiActionExecuteSchema`): `mediaItemIds` is
// required, so a key can never run a rule set's action on "every match", and
// holds at most 25 ids. The handler then charges any deleting action to the
// API's destructive budget (see `src/lib/api-keys/limits.ts`).
export const POST = withApiKey("lifecycle:execute", async (request: NextRequest) => {
  const { data, error } = await validateRequest(request, apiActionExecuteSchema);
  if (error) return error;
  return appPost(
    new NextRequest(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
  );
});
