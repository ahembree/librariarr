import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { fetchTrashCatalog, deriveCategories } from "@/lib/trash/catalog";
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
        // Lightweight custom-format list (name + id + recommended default
        // score) for attaching custom formats to a quality profile.
        customFormats: catalog.customFormats.map((c) => ({
          trashId: c.trash_id,
          name: c.name,
          defaultScore: c.trash_scores?.default ?? 0,
        })),
        // Top-level categories derived from the cf-group `[Bracket]` prefixes,
        // for drilling down the format list.
        categories: deriveCategories(catalog.cfGroups),
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
