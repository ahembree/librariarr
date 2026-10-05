import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, trashSyncSchema } from "@/lib/validation";
import { resolveInstance } from "@/lib/trash/status";
import { runTrashSync } from "@/lib/trash/sync";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

// Run a sync or a dry-run/preview. A real sync (dryRun=false) writes ONLY to
// resources the user has assigned/managed — on apply, `items` only narrows the
// run to a subset of the managed rows, so nothing is ever written to an Arr
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
  const dryRun = data.dryRun ?? false;
  // A disabled instance is switched off everywhere else in the app; writing
  // guide resources to it would be the one thing that still reaches it. A
  // preview only reads, so it stays available.
  if (!dryRun && !inst.enabled) {
    return NextResponse.json({ error: "Instance is disabled" }, { status: 409 });
  }

  try {
    const report = await runTrashSync(session.userId!, inst, {
      dryRun,
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
