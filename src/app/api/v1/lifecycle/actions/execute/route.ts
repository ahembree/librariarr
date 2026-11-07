import { NextRequest } from "next/server";
import { POST as appPost } from "@/app/api/lifecycle/actions/execute/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { validateRequest, apiActionExecuteSchema } from "@/lib/validation";

// Public API mirror of /api/lifecycle/actions/execute — same response. Takes
// less than the app's route (see `apiActionExecuteSchema`): `mediaItemIds` is
// required, so a key can never run a rule set's action on "every match", and
// holds at most 25 ids. The handler then charges any deleting action to the
// API's destructive budget (see `src/lib/api-keys/limits.ts`). The app route
// can stream its progress for the Pending page; this mirror never does (the
// query string is not forwarded, and the handler checks the key as well).
export const POST = withApiKey("lifecycle:execute", async (request: NextRequest) => {
  const { data, error } = await validateRequest(request, apiActionExecuteSchema);
  if (error) return error;
  // Without the caller's query string: the app's route streams its progress
  // on `?stream=1` (the Pending page), and the public API answers one JSON
  // body — the handler also refuses to stream under a key, but the API never
  // forwards the switch in the first place.
  const url = new URL(request.url);
  url.search = "";
  return appPost(
    new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
  );
});
