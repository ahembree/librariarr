/**
 * Regression guard for the "ungated but type-specific Arr field" bug class.
 *
 * The bug: an Arr criterion (e.g. arrSeasonCount) is offered on a media type
 * whose fetcher never populates the underlying value (it's hardcoded `null`),
 * so the rule is accepted but silently matches nothing — or, under
 * negate/isNull, matches everything (a deletion-correctness risk).
 *
 * Rather than restate the expected gating by hand (which a new field could
 * dodge), this test DERIVES the population matrix from the real fetcher output:
 * feed each fetcher (Radarr/Sonarr/Lidarr) a single, maximally-populated item,
 * read back the ArrMetadata, and treat any `null` value as "not populated for
 * this type". The field's `invalidForLibraryType` gate in CONDITION_FIELDS must
 * then match exactly the set of types where its backing value is null.
 *
 * If someone adds a new Arr field — or changes a fetcher to start/stop
 * populating a value — and forgets to update the gate, this fails.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CONDITION_FIELDS } from "@/lib/conditions";
import type { ArrMetadata } from "@/lib/rules/lifecycle-engine";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findMany: vi.fn() },
  sonarrInstance: { findMany: vi.fn() },
  lidarrInstance: { findMany: vi.fn() },
}));
const mockRadarr = vi.hoisted(() => ({ getMovies: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn(), getCustomFormatScores: vi.fn() }));
const mockSonarr = vi.hoisted(() => ({ getSeries: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn() }));
const mockLidarr = vi.hoisted(() => ({ getArtists: vi.fn(), getQualityProfiles: vi.fn(), getTags: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/arr/radarr-client", () => ({ RadarrClient: function () { return mockRadarr; } }));
vi.mock("@/lib/arr/sonarr-client", () => ({ SonarrClient: function () { return mockSonarr; } }));
vi.mock("@/lib/arr/lidarr-client", () => ({ LidarrClient: function () { return mockLidarr; } }));

import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";

/**
 * Maps each Arr CONDITION_FIELDS value to the ArrMetadata key whose null-ness
 * decides whether the field is populated for a given type. This is the one
 * piece that must be maintained by hand; the completeness test below fails if a
 * new Arr field is added without an entry here, so it can't silently drift.
 *
 * `null` value = the field doesn't read a per-item nullable ArrMetadata value
 * (foundInArr is presence-based; arrTag/arrQualityProfile/arrMonitored are
 * always populated for every type) — these are expected to be ungated.
 */
const FIELD_TO_META_KEY: Record<string, keyof ArrMetadata | null> = {
  foundInArr: null,
  arrMonitored: null,
  arrTag: null,
  arrQualityProfile: null,
  arrRating: null, // populated (nullable in data, but valid for all 3 types)
  arrSizeOnDisk: null,
  arrPath: null,
  arrDateAdded: null,
  arrStatus: null, // now populated for all three types
  // Type-specific (gate must mirror which types leave these null):
  arrTmdbRating: "tmdbRating",
  arrRtCriticRating: "rtCriticRating",
  arrOriginalLanguage: "originalLanguage",
  arrReleaseDate: "releaseDate",
  arrInCinemasDate: "inCinemasDate",
  arrRuntime: "runtime",
  arrQualityName: "qualityName",
  arrQualityCutoffMet: "qualityCutoffMet",
  arrCustomFormatScore: "customFormatScore",
  arrDownloadDate: "downloadDate",
  arrFirstAired: "firstAired",
  arrSeasonCount: "seasonCount",
  arrEpisodeCount: "episodeCount",
  arrEnded: "ended",
  arrSeriesType: "seriesType",
  arrHasUnaired: "hasUnaired",
  arrMonitoredSeasonCount: "monitoredSeasonCount",
  arrMonitoredEpisodeCount: "monitoredEpisodeCount",
};

// A movie/series/artist object with EVERY input the fetcher reads set to a
// non-null value, so any null in the output is a deliberate per-type omission.
const fullMovie = {
  id: 1, tmdbId: 100, tags: [], qualityProfileId: 1, monitored: true,
  ratings: { imdb: { value: 8 }, tmdb: { value: 7 }, rottenTomatoes: { value: 90 } },
  added: "2024-01-01", path: "/m", sizeOnDisk: 1000, originalLanguage: { name: "English" },
  digitalRelease: "2024-02-01", physicalRelease: "2024-03-01", inCinemas: "2024-01-15",
  runtime: 120, hasFile: true,
  movieFile: { quality: { quality: { name: "Bluray-1080p" } }, dateAdded: "2024-02-02", qualityCutoffNotMet: false },
  status: "released",
};
const fullSeries = {
  id: 1, tvdbId: 200, tags: [], qualityProfileId: 1, monitored: true,
  ratings: { imdb: { value: 9 }, tmdb: { value: 8 }, rottenTomatoes: { value: 95 } },
  added: "2023-01-01", path: "/s", statistics: { sizeOnDisk: 2000, seasonCount: 3, episodeCount: 30 },
  originalLanguage: { name: "English" }, firstAired: "2020-01-01", status: "continuing",
  ended: false, seriesType: "standard", nextAiring: "2025-01-01",
  seasons: [{ monitored: true, statistics: { episodeCount: 10 } }],
};
const fullArtist = {
  id: 1, foreignArtistId: "mb-1", tags: [], qualityProfileId: 1, monitored: true,
  ratings: { value: 7 }, added: "2024-01-01", path: "/a", statistics: { sizeOnDisk: 3000 },
  status: "continuing",
};

describe("Arr field gating mirrors fetcher population (regression guard)", () => {
  let populated: Record<"MOVIE" | "SERIES" | "MUSIC", ArrMetadata>;

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const m of [mockRadarr, mockSonarr, mockLidarr]) {
      m.getQualityProfiles.mockResolvedValue([{ id: 1, name: "P" }]);
      m.getTags.mockResolvedValue([]);
    }
    mockPrisma.radarrInstance.findMany.mockResolvedValue([{ id: "r", url: "u", apiKey: "k" }]);
    mockPrisma.sonarrInstance.findMany.mockResolvedValue([{ id: "s", url: "u", apiKey: "k" }]);
    mockPrisma.lidarrInstance.findMany.mockResolvedValue([{ id: "l", url: "u", apiKey: "k" }]);
    mockRadarr.getMovies.mockResolvedValue([fullMovie]);
    // customFormatScore is sourced from the /moviefile endpoint, not the /movie
    // listing — supply it here so the movie's backing value is non-null.
    mockRadarr.getCustomFormatScores.mockResolvedValue(new Map([[fullMovie.id, 50]]));
    mockSonarr.getSeries.mockResolvedValue([fullSeries]);
    mockLidarr.getArtists.mockResolvedValue([fullArtist]);

    const [mv, se, mu] = await Promise.all([
      fetchArrMetadata("u", "MOVIE"),
      fetchArrMetadata("u", "SERIES"),
      fetchArrMetadata("u", "MUSIC"),
    ]);
    populated = {
      MOVIE: Object.values(mv)[0],
      SERIES: Object.values(se)[0],
      MUSIC: Object.values(mu)[0],
    };
  });

  it("every Arr field has a FIELD_TO_META_KEY entry (forces review when fields are added)", () => {
    const arrFields = CONDITION_FIELDS.filter((f) => f.requiresArr).map((f) => f.value);
    const mapped = Object.keys(FIELD_TO_META_KEY);
    expect([...arrFields].sort()).toEqual([...mapped].sort());
  });

  it("each field's invalidForLibraryType matches exactly the types whose fetcher leaves it null", () => {
    const types = ["MOVIE", "SERIES", "MUSIC"] as const;
    for (const field of CONDITION_FIELDS.filter((f) => f.requiresArr)) {
      const metaKey = FIELD_TO_META_KEY[field.value];
      const gate = new Set(field.invalidForLibraryType ?? []);

      if (metaKey === null) {
        // All-type field: must be ungated.
        expect(gate.size, `${field.value} should be ungated (all-type)`).toBe(0);
        continue;
      }

      // Types where the fetcher left the backing value null = types where the
      // field can never match = exactly the types that must be gated out.
      const nullTypes = new Set(types.filter((t) => populated[t][metaKey] === null));
      expect(
        [...gate].sort(),
        `${field.value} gate must equal the types where ${String(metaKey)} is null`,
      ).toEqual([...nullTypes].sort());
    }
  });
});
