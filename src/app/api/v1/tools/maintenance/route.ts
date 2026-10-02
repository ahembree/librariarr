import { NextRequest } from "next/server";
import { GET as appGet, PUT as appPut } from "@/app/api/tools/maintenance/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { validateRequest, apiMaintenanceSchema } from "@/lib/validation";

// Public API mirror of /api/tools/maintenance — same response. GET takes the
// same parameters; PUT only `enabled`, `message` and `delay` (see
// `apiMaintenanceSchema`), and hands the Settings handler a body holding just
// those, so the exemptions and the Discord toggle cannot be reached from here.
export const GET = withApiKey("streams:read", appGet);
export const PUT = withApiKey("streams:write", async (request: NextRequest) => {
  const { data, error } = await validateRequest(request, apiMaintenanceSchema);
  if (error) return error;
  return appPut(
    new NextRequest(request.url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
  );
});
