import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SonarrClient } from "@/lib/arr/sonarr-client";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const instance = await prisma.sonarrInstance.findFirst({
    where: { id, userId: session.userId },
  });

  if (!instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  const client = new SonarrClient(instance.url, instance.apiKey);
  const [series, qualityProfiles, tags, languages] = await Promise.all([
    client.getSeries(),
    client.getQualityProfiles(),
    client.getTags(),
    client.getLanguages(),
  ]);

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(qualityProfiles.map((p) => [p.id, p.name]));

  const seriesLookup: Record<
    string,
    {
      tags: string[];
      qualityProfile: string;
      monitored: boolean;
      rating: number | null;
    }
  > = {};

  for (const s of series) {
    seriesLookup[String(s.tvdbId)] = {
      tags: s.tags.map((tid) => tagMap.get(tid) ?? String(tid)),
      qualityProfile: profileMap.get(s.qualityProfileId) ?? "Unknown",
      monitored: s.monitored,
      rating: s.ratings?.imdb?.value ?? null,
    };
  }

  return NextResponse.json({
    series: seriesLookup,
    tags: tags.map((t) => ({ id: t.id, label: t.label })),
    qualityProfiles: qualityProfiles.map((p) => ({ id: p.id, name: p.name })),
    languages: languages
      .filter((l) => l.name && l.name !== "Unknown")
      .map((l) => l.name)
      .sort((a, b) => a.localeCompare(b)),
    // Distinct values present in the library for the enumerable arrStatus /
    // arrSeriesType fields, so the builders can render dropdowns instead of
    // a raw text input. Only series carry these (movies/music leave them null
    // in fetch-arr-metadata), so they're sourced from Sonarr only.
    statuses: [...new Set(series.map((s) => s.status).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b)),
    seriesTypes: [...new Set(series.map((s) => s.seriesType).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b)),
  });
}
