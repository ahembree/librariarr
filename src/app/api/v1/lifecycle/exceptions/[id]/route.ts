import { NextRequest } from "next/server";
import { DELETE as appDelete } from "@/app/api/lifecycle/exceptions/[id]/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { removeExceptionsCharged } from "@/lib/api-keys/exception-removal";

type Context = { params: Promise<{ id: string }> };

// Public API mirror of /api/lifecycle/exceptions/[id] — same parameters and
// response. Removing an exception lifts a protection against deletion, so it
// needs the destructive scope and is charged to the API's destructive budget
// (see ../route.ts).
export const DELETE = withApiKey("lifecycle:execute", async (request: NextRequest, context: Context) => {
  const { id } = await context.params;
  return removeExceptionsCharged(
    [id],
    () => appDelete(request, context),
    async () => 1,
  );
});
