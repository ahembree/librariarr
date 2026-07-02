import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { resolveInstance, guideClientFor } from "@/lib/trash/status";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import type { ServiceType } from "@/lib/trash/types";

// Lists the quality profiles that exist on an instance (including ones the user
// created directly in the app), each with its current custom-format scores, so
// the UI can attach guide custom formats to any profile.
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
    const client = guideClientFor(inst);
    const profiles = await client.getQualityProfiles();
    // Every custom format that exists in the instance (Arr lists all of them on
    // each profile's formatItems). Used by the UI to flag an assigned format
    // that isn't in the app yet — scoring it is a no-op until it's added & synced.
    const instanceFormatNames = [
      ...new Set(profiles.flatMap((p) => (p.formatItems ?? []).map((f) => f.name))),
    ].sort();
    return NextResponse.json({
      instanceFormatNames,
      profiles: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        // Only the non-zero current scores, keyed by custom-format name.
        formatScores: Object.fromEntries(
          (p.formatItems ?? []).filter((f) => f.score !== 0).map((f) => [f.name, f.score]),
        ),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to load quality profiles",
        detail: sanitizeErrorDetail(err instanceof Error ? err.message : undefined),
      },
      { status: 502 },
    );
  }
}
