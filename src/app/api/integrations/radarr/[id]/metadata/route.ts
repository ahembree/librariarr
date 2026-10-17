import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const instance = await prisma.radarrInstance.findFirst({
    where: { id, userId: session.userId },
  });

  if (!instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  const client = new RadarrClient(instance.url, instance.apiKey);
  let movies, qualityProfiles, tags, languages;
  try {
    [movies, qualityProfiles, tags, languages] = await Promise.all([
      client.getMovies(),
      client.getQualityProfiles(),
      client.getTags(),
      client.getLanguages(),
    ]);
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : "Failed to query Radarr";
    const msg = sanitizeErrorDetail(raw) ?? "Failed to query Radarr";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(qualityProfiles.map((p) => [p.id, p.name]));

  const movieLookup: Record<
    string,
    {
      tags: string[];
      qualityProfile: string;
      monitored: boolean;
      rating: number | null;
    }
  > = {};

  for (const movie of movies) {
    movieLookup[String(movie.tmdbId)] = {
      tags: movie.tags.map((tid) => tagMap.get(tid) ?? String(tid)),
      qualityProfile: profileMap.get(movie.qualityProfileId) ?? "Unknown",
      monitored: movie.monitored,
      rating: movie.ratings?.imdb?.value ?? null,
    };
  }

  return NextResponse.json({
    movies: movieLookup,
    tags: tags.map((t) => ({ id: t.id, label: t.label })),
    qualityProfiles: qualityProfiles.map((p) => ({ id: p.id, name: p.name })),
    // The values Original Language is matched against: real languages only.
    // /language also lists Unknown (id 0) and the quality-profile
    // pseudo-languages Any (-1) and Original (-2); no title's original
    // language is Any or Original, so a rule picking one matched nothing.
    languages: languages
      .filter((l) => l.name && l.id > 0)
      .map((l) => l.name)
      .sort((a, b) => a.localeCompare(b)),
    // Distinct downloaded-file quality names present in the library, for the
    // enumerable arrQualityName field. Only movies carry a per-item quality
    // name in fetch-arr-metadata (series/music leave it null), so it's sourced
    // from Radarr only. Movies with no file have no quality name — filtered out.
    qualityNames: [...new Set(
      movies.map((m) => m.movieFile?.quality?.quality?.name).filter((v): v is string => !!v),
    )].sort((a, b) => a.localeCompare(b)),
    // Distinct movie statuses (tba | announced | inCinemas | released | deleted)
    // present in the library, for the enumerable arrStatus field.
    statuses: [...new Set(
      movies.map((m) => m.status).filter((v): v is string => !!v),
    )].sort((a, b) => a.localeCompare(b)),
  });
}
