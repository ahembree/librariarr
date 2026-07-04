import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, trashSyncSchema } from "@/lib/validation";
import { resolveInstance } from "@/lib/trash/status";
import { runTrashSync } from "@/lib/trash/sync";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

// Run a sync or a dry-run/preview. A real sync (dryRun=false) writes ONLY to
// resources the user has assigned/managed — `items` is honored only for
// dry-run previews, never for applying, so nothing is ever written to an Arr
// without an explicit managed row.
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, trashSyncSchema);
  if (error) return error;

  const inst = await resolveInstance(session.userId!, data.serviceType, data.instanceId);
  if (!inst) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  try {
    const report = await runTrashSync(session.userId!, inst, {
      dryRun: data.dryRun ?? false,
      items: data.items,
    });
    return NextResponse.json({ report });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Sync failed",
        detail: sanitizeErrorDetail(err instanceof Error ? err.message : undefined),
      },
      { status: 502 },
    );
  }
}
