import { NextRequest } from "next/server";
import { GET as appGet, POST as appPost, DELETE as appDelete } from "@/app/api/lifecycle/exceptions/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { reserveExceptionRemoval } from "@/lib/api-keys/exception-removal";
import { validateRequest, apiExceptionDeleteSchema } from "@/lib/validation";

// Public API mirror of /api/lifecycle/exceptions — same parameters and response.
// It has no paging, so each read is charged as a full listing.
export const GET = withApiKey("lifecycle:read", appGet, { fullListing: true });
// Adding an exception only ever protects media.
export const POST = withApiKey("lifecycle:write", appPost);
// Removing one lifts that protection, after which the rules can match the item
// and the executor delete it — so it needs the destructive scope, not
// `lifecycle:write`, or that scope could get protected media deleted. For the
// same reason it takes at most 25 ids (`apiExceptionDeleteSchema`) and each
// removal is charged to the API's destructive budget.
export const DELETE = withApiKey("lifecycle:execute", async (request: NextRequest) => {
  const { data, error } = await validateRequest(request, apiExceptionDeleteSchema);
  if (error) return error;
  const ids = [...new Set(data.ids)];
  const refusal = await reserveExceptionRemoval(ids);
  if (refusal) return refusal;
  return appDelete(
    new NextRequest(request.url, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  );
});
