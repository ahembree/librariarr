import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { apiLogger } from "@/lib/logger";
import { withTimeout } from "@/lib/api/bounded";

// Longest a detail page waits for any one Arr instance (see `withTimeout`).
const PER_INSTANCE_TIMEOUT_MS = 10_000;

interface ArrMatch {
  type: "sonarr" | "radarr" | "lidarr";
  instanceId: string;
  instanceName: string;
  qualityProfileName: string | null;
  matchedVia: string;
  externalId: string;
  tags: string[];
  arrUrl: string | null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const item = await prisma.mediaItem.findUnique({
    where: { id },
    include: {
      externalIds: true,
      library: {
        include: { mediaServer: true },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!item.library.mediaServer || item.library.mediaServer.userId !== session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // One live lookup per instance, in parallel, each bounded: a timing-out
  // instance costs its client's whole retry budget (4 × 15s + backoff), and it
  // must neither hold back the other instances' cards nor keep the detail
  // page's Integrations section spinning for a minute.
  const bounded = <T,>(instanceName: string, work: Promise<T>) =>
    withTimeout(work, PER_INSTANCE_TIMEOUT_MS, () =>
      apiLogger.warn("Media", `Arr instance ${instanceName} did not answer within ${PER_INSTANCE_TIMEOUT_MS / 1000}s`),
    );
  const collect = async <I extends { name: string }>(
    instances: I[],
    service: string,
    query: (instance: I) => Promise<ArrMatch | null>,
  ): Promise<ArrMatch[]> => {
    const results = await Promise.all(
      instances.map((instance) =>
        bounded(
          instance.name,
          query(instance).catch((error) => {
            apiLogger.error("Media", `Failed to query ${service} instance ${instance.name}`, { error: String(error) });
            return null;
          }),
        ),
      ),
    );
    return results.filter((m): m is ArrMatch => m !== null);
  };

  let matches: ArrMatch[] = [];

  try {
    if (item.type === "MOVIE") {
      const tmdbId = item.externalIds.find((e) => e.source === "TMDB");
      if (!tmdbId) return NextResponse.json({ matches });

      const radarrInstances = await prisma.radarrInstance.findMany({
        where: { userId: session.userId!, enabled: true },
        orderBy: { createdAt: "asc" },
      });

      matches = await collect(radarrInstances, "Radarr", async (instance) => {
        const client = new RadarrClient(instance.url, instance.apiKey);
        const movie = await client.getMovieByTmdbId(parseInt(tmdbId.externalId));
        if (!movie) return null;
        const [profiles, allTags] = await Promise.all([
          client.getQualityProfiles(),
          movie.tags.length > 0 ? client.getTags() : Promise.resolve([]),
        ]);
        const currentProfile = profiles.find((p) => p.id === movie.qualityProfileId);
        const tagMap = new Map(allTags.map((t) => [t.id, t.label]));
        const radarrBaseUrl = instance.externalUrl || instance.url;
        return {
          type: "radarr",
          instanceId: instance.id,
          instanceName: instance.name,
          qualityProfileName: currentProfile?.name ?? null,
          matchedVia: "TMDB",
          externalId: tmdbId.externalId,
          tags: movie.tags
            .map((id) => tagMap.get(id))
            .filter((label): label is string => !!label),
          arrUrl: `${radarrBaseUrl}/movie/${movie.tmdbId}`,
        };
      });
    } else if (item.type === "MUSIC") {
      const mbId = item.externalIds.find((e) => e.source === "MUSICBRAINZ");
      if (!mbId) return NextResponse.json({ matches });

      const lidarrInstances = await prisma.lidarrInstance.findMany({
        where: { userId: session.userId!, enabled: true },
        orderBy: { createdAt: "asc" },
      });

      matches = await collect(lidarrInstances, "Lidarr", async (instance) => {
        const client = new LidarrClient(instance.url, instance.apiKey);
        const artist = await client.getArtistByMusicBrainzId(mbId.externalId);
        if (!artist) return null;
        const [profiles, allTags] = await Promise.all([
          client.getQualityProfiles(),
          artist.tags.length > 0 ? client.getTags() : Promise.resolve([]),
        ]);
        const currentProfile = profiles.find((p) => p.id === artist.qualityProfileId);
        const tagMap = new Map(allTags.map((t) => [t.id, t.label]));
        const lidarrBaseUrl = instance.externalUrl || instance.url;
        return {
          type: "lidarr",
          instanceId: instance.id,
          instanceName: instance.name,
          qualityProfileName: currentProfile?.name ?? null,
          matchedVia: "MUSICBRAINZ",
          externalId: mbId.externalId,
          tags: artist.tags
            .map((id) => tagMap.get(id))
            .filter((label): label is string => !!label),
          arrUrl: `${lidarrBaseUrl}/artist/${artist.foreignArtistId}`,
        };
      });
    } else {
      const tvdbId = item.externalIds.find((e) => e.source === "TVDB");
      if (!tvdbId) return NextResponse.json({ matches });

      const sonarrInstances = await prisma.sonarrInstance.findMany({
        where: { userId: session.userId!, enabled: true },
        orderBy: { createdAt: "asc" },
      });

      matches = await collect(sonarrInstances, "Sonarr", async (instance) => {
        const client = new SonarrClient(instance.url, instance.apiKey);
        const series = await client.getSeriesByTvdbId(parseInt(tvdbId.externalId));
        if (!series) return null;
        const [profiles, allTags] = await Promise.all([
          client.getQualityProfiles(),
          series.tags.length > 0 ? client.getTags() : Promise.resolve([]),
        ]);
        const currentProfile = profiles.find((p) => p.id === series.qualityProfileId);
        const tagMap = new Map(allTags.map((t) => [t.id, t.label]));
        const sonarrBaseUrl = instance.externalUrl || instance.url;
        return {
          type: "sonarr",
          instanceId: instance.id,
          instanceName: instance.name,
          qualityProfileName: currentProfile?.name ?? null,
          matchedVia: "TVDB",
          externalId: tvdbId.externalId,
          tags: series.tags
            .map((id) => tagMap.get(id))
            .filter((label): label is string => !!label),
          arrUrl: series.titleSlug
            ? `${sonarrBaseUrl}/series/${series.titleSlug}`
            : `${sonarrBaseUrl}/series/${series.id}`,
        };
      });
    }
  } catch (error) {
    apiLogger.error("Media", "Failed to fetch arr info", { error: String(error) });
  }

  return NextResponse.json({ matches });
}
