import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { resolveInstance, computeTrashStatus } from "@/lib/trash/status";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import type { ServiceType } from "@/lib/trash/types";

// Cross-references the guide catalog, the instance's live resources, and the
// user's managed rows into a per-item status list (NEW / UNMANAGED_CONFLICT /
// MANAGED / MANAGED_OUTDATED / MANAGED_MISSING).
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const serviceType = searchParams.get("serviceType")?.toUpperCase();
  const instanceId = searchParams.get("instanceId");
  if (serviceType !== "SONARR" && serviceType !== "RADARR") {
    return NextResponse.json({ error: "serviceType must be SONARR or RADARR" }, { status: 400 });
  }
  if (!instanceId) {
    return NextResponse.json({ error: "instanceId is required" }, { status: 400 });
  }

  const inst = await resolveInstance(session.userId!, serviceType as ServiceType, instanceId);
  if (!inst) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  try {
    const status = await computeTrashStatus(session.userId!, inst);
    return NextResponse.json({ status });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to load guide status",
        detail: sanitizeErrorDetail(err instanceof Error ? err.message : undefined),
      },
      { status: 502 },
    );
  }
}
