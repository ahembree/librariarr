import type { RadarrClient } from "@/lib/arr/radarr-client";
import type { SonarrClient } from "@/lib/arr/sonarr-client";
import type { LidarrClient } from "@/lib/arr/lidarr-client";
import { seerrRequesterKey, type SeerrClient } from "@/lib/seerr/seerr-client";
import { logger } from "@/lib/logger";
import type { InstanceRow } from "./instance-routes";

/**
 * The dropdown values the rule editor and the Query page read from one
 * instance (`GET /api/integrations/<type>/[id]/metadata`).
 *
 * These used to return a per-item map too — every movie by TMDB id, every
 * series by TVDB id, every artist by MusicBrainz id, with its tags, profile,
 * monitored flag and rating — which no caller read (the engines fetch Arr data
 * themselves, `src/lib/lifecycle/fetch-arr-metadata.ts`). It was most of the
 * response: a whole library's worth of rows, for a few tags and profiles.
 */

const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b));

/**
 * The values Original Language is matched against: real languages only.
 * /language also lists Unknown (id 0) and the quality-profile pseudo-languages
 * Any (-1, Radarr) and Original (-2); no title's original language is Any or
 * Original, so a rule picking one matched nothing.
 */
const realLanguages = (languages: { id: number; name: string }[]) =>
  languages.filter((l) => l.name && l.id > 0).map((l) => l.name).sort((a, b) => a.localeCompare(b));

export async function loadRadarrMetadata(client: RadarrClient): Promise<Record<string, unknown>> {
  const [movies, qualityProfiles, tags, languages] = await Promise.all([
    client.getMovies(),
    client.getQualityProfiles(),
    client.getTags(),
    client.getLanguages(),
  ]);
  return {
    tags: tags.map((t) => ({ id: t.id, label: t.label })),
    qualityProfiles: qualityProfiles.map((p) => ({ id: p.id, name: p.name })),
    languages: realLanguages(languages),
    // Distinct downloaded-file quality names present in the library, for the
    // enumerable arrQualityName field. Only movies carry a per-item quality
    // name in fetch-arr-metadata (series/music leave it null), so it's sourced
    // from Radarr only. Movies with no file have no quality name — filtered out.
    qualityNames: sorted(movies.map((m) => m.movieFile?.quality?.quality?.name).filter((v): v is string => !!v)),
    // Distinct movie statuses (tba | announced | inCinemas | released | deleted)
    // present in the library, for the enumerable arrStatus field.
    statuses: sorted(movies.map((m) => m.status).filter((v): v is string => !!v)),
  };
}

export async function loadSonarrMetadata(client: SonarrClient): Promise<Record<string, unknown>> {
  const [series, qualityProfiles, tags, languages] = await Promise.all([
    client.getSeries(),
    client.getQualityProfiles(),
    client.getTags(),
    client.getLanguages(),
  ]);
  return {
    tags: tags.map((t) => ({ id: t.id, label: t.label })),
    qualityProfiles: qualityProfiles.map((p) => ({ id: p.id, name: p.name })),
    languages: realLanguages(languages),
    // Distinct values present in the library for the enumerable arrStatus /
    // arrSeriesType fields, so the builders can render dropdowns instead of
    // a raw text input. Only series carry these (movies/music leave them null
    // in fetch-arr-metadata), so they're sourced from Sonarr only.
    statuses: sorted(series.map((s) => s.status).filter((v): v is string => !!v)),
    seriesTypes: sorted(series.map((s) => s.seriesType).filter((v): v is string => !!v)),
  };
}

export async function loadLidarrMetadata(client: LidarrClient): Promise<Record<string, unknown>> {
  const [artists, qualityProfiles, tags] = await Promise.all([
    client.getArtists(),
    client.getQualityProfiles(),
    client.getTags(),
  ]);
  return {
    tags: tags.map((t) => ({ id: t.id, label: t.label })),
    qualityProfiles: qualityProfiles.map((p) => ({ id: p.id, name: p.name })),
    // Distinct artist statuses (continuing | ended | deleted) present in the
    // library, for the enumerable arrStatus field.
    statuses: sorted(artists.map((a) => a.status).filter((v): v is string => !!v)),
  };
}

// Hard ceiling on Seerr pagination so a huge or misbehaving instance can't
// hang the request indefinitely. 100 pages × 100 per page = 10k users.
const SEERR_MAX_PAGES = 100;
const SEERR_PAGE_SIZE = 100;

/** Every Seerr user's requester name — what "Requested By" rules evaluate. */
export async function loadSeerrMetadata(client: SeerrClient, instance: InstanceRow): Promise<Record<string, unknown>> {
  const users: string[] = [];
  let skip = 0;
  let hasMore = true;
  let pages = 0;
  while (hasMore) {
    if (pages >= SEERR_MAX_PAGES) {
      logger.warn("Seerr", `Users pagination hit MAX_PAGES (${SEERR_MAX_PAGES}) for ${instance.name} — truncating`);
      break;
    }
    const response = await client.getUsers({ take: SEERR_PAGE_SIZE, skip });
    for (const user of response.results) {
      // Same name the rule engine evaluates "Requested By" against.
      const name = seerrRequesterKey(user);
      if (name) users.push(name);
    }
    skip += SEERR_PAGE_SIZE;
    pages += 1;
    hasMore = response.results.length === SEERR_PAGE_SIZE;
  }
  return { users: sorted(users) };
}
