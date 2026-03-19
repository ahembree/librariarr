import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { apiLogger } from "@/lib/logger";

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

  const matches: ArrMatch[] = [];

  try {
    if (item.type === "MOVIE") {
      const tmdbId = item.externalIds.find((e) => e.source === "TMDB");
      if (!tmdbId) return NextResponse.json({ matches, plexRatingKey: item.ratingKey });

      const radarrInstances = await prisma.radarrInstance.findMany({
        where: { userId: session.userId! },
      });

      for (const instance of radarrInstances) {
        try {
          const client = new RadarrClient(instance.url, instance.apiKey);
          const movie = await client.getMovieByTmdbId(
            parseInt(tmdbId.externalId)
          );
          if (movie) {
            const [profiles, allTags] = await Promise.all([
              client.getQualityProfiles(),
              movie.tags.length > 0 ? client.getTags() : Promise.resolve([]),
            ]);
            const currentProfile = profiles.find(
              (p) => p.id === movie.qualityProfileId
            );
            const tagMap = new Map(allTags.map((t) => [t.id, t.label]));
            const radarrBaseUrl = instance.externalUrl || instance.url;
            matches.push({
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
            });
          }
        } catch (error) {
          apiLogger.error("Media", `Failed to query Radarr instance ${instance.name}`, { error: String(error) });
        }
      }
    } else if (item.type === "MUSIC") {
      const mbId = item.externalIds.find((e) => e.source === "MUSICBRAINZ");
      if (!mbId) return NextResponse.json({ matches, plexRatingKey: item.ratingKey });

      const lidarrInstances = await prisma.lidarrInstance.findMany({
        where: { userId: session.userId! },
      });

      for (const instance of lidarrInstances) {
        try {
          const client = new LidarrClient(instance.url, instance.apiKey);
          const artist = await client.getArtistByMusicBrainzId(mbId.externalId);
          if (artist) {
            const [profiles, allTags] = await Promise.all([
              client.getQualityProfiles(),
              artist.tags.length > 0 ? client.getTags() : Promise.resolve([]),
            ]);
            const currentProfile = profiles.find(
              (p) => p.id === artist.qualityProfileId
            );
            const tagMap = new Map(allTags.map((t) => [t.id, t.label]));
            const lidarrBaseUrl = instance.externalUrl || instance.url;
            matches.push({
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
            });
          }
        } catch (error) {
          apiLogger.error("Media", `Failed to query Lidarr instance ${instance.name}`, { error: String(error) });
        }
      }
    } else {
      const tvdbId = item.externalIds.find((e) => e.source === "TVDB");
      if (!tvdbId) return NextResponse.json({ matches, plexRatingKey: item.ratingKey });

      const sonarrInstances = await prisma.sonarrInstance.findMany({
        where: { userId: session.userId! },
      });

      for (const instance of sonarrInstances) {
        try {
          const client = new SonarrClient(instance.url, instance.apiKey);
          const series = await client.getSeriesByTvdbId(
            parseInt(tvdbId.externalId)
          );
          if (series) {
            const [profiles, allTags] = await Promise.all([
              client.getQualityProfiles(),
              series.tags.length > 0 ? client.getTags() : Promise.resolve([]),
            ]);
            const currentProfile = profiles.find(
              (p) => p.id === series.qualityProfileId
            );
            const tagMap = new Map(allTags.map((t) => [t.id, t.label]));
            const sonarrBaseUrl = instance.externalUrl || instance.url;
            matches.push({
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
            });
          }
        } catch (error) {
          apiLogger.error("Media", `Failed to query Sonarr instance ${instance.name}`, { error: String(error) });
        }
      }
    }
  } catch (error) {
    apiLogger.error("Media", "Failed to fetch arr info", { error: String(error) });
  }

  return NextResponse.json({ matches, plexRatingKey: item.ratingKey });
}
