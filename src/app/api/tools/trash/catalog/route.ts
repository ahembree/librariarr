import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { fetchTrashCatalog } from "@/lib/trash/catalog";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import type { ServiceType } from "@/lib/trash/types";

// Returns guide metadata for a service: counts, fetch time, and the naming
// variants (needed by the naming-selection UI). Per-item browsing/status comes
// from the status endpoint, so the heavy custom-format specs are omitted here.
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const service = searchParams.get("service")?.toUpperCase();
  if (service !== "SONARR" && service !== "RADARR") {
    return NextResponse.json({ error: "service must be 'sonarr' or 'radarr'" }, { status: 400 });
  }
  const force = searchParams.get("refresh") === "1";

  try {
    const catalog = await fetchTrashCatalog(service as ServiceType, { force });
    return NextResponse.json({
      catalog: {
        service: catalog.service,
        ref: catalog.ref,
        fetchedAt: catalog.fetchedAt,
        counts: {
          customFormats: catalog.customFormats.length,
          qualityProfiles: catalog.qualityProfiles.length,
          qualitySize: catalog.qualitySize ? 1 : 0,
          naming: catalog.naming ? 1 : 0,
        },
        naming: catalog.naming,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to load guide catalog",
        detail: sanitizeErrorDetail(err instanceof Error ? err.message : undefined),
      },
      { status: 502 },
    );
  }
}
