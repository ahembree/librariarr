import { prisma } from "@/lib/db";
import type { LibraryType } from "@/generated/prisma/client";
import type {
  TracearrHistoryRecord,
  TracearrMediaType,
} from "@/lib/tracearr/tracearr-client";

/**
 * Resolving a Tracearr `HistoryRecord` to one of **our** `MediaItem` rows.
 *
 * This is the one genuinely dangerous part of the Tracearr import. A
 * `WatchHistory` row is not a display-only artefact: `watch-reconcile.ts` rolls
 * it up into `MediaItem.playCount` / `lastPlayedAt`, which are exactly the
 * columns `seriesLastPlayedAt`, `watchedEpisodeCount` and
 * `watchedEpisodePercentage` derive from — the fields destructive lifecycle
 * rules are written against. And those writes are monotonic `GREATEST`, so a
 * play attributed to the wrong item can never be walked back by a later sync.
 *
 * The resolver is therefore deliberately biased: **a dropped play is strictly
 * better than a wrong one.** Every ambiguity resolves to a skip, never to a
 * best guess.
 *
 * Two-step resolution, in this order:
 *
 *  1. `rating_key` → `MediaItem.ratingKey`, scoped to this media server. That
 *     column IS the server's own primary identity for the item and is exactly
 *     what the sync stored for it, so an exact single hit needs no
 *     corroboration. Zero hits fall through to (2); more than one hit is a skip
 *     (the schema does not enforce uniqueness on `(library, ratingKey)`, so two
 *     rows can collide and there is no way to pick).
 *
 *  2. Provider-id fallback — `tvdb_id` → `tmdb_id` → `imdb_id`, the same
 *     precedence `computeSeriesKey` uses. This is what rescues a record whose
 *     `rating_key` is null (the server never gave Tracearr one) or stale (the
 *     item was re-added and got a new key). It is also where the mis-join
 *     hazard lives, because the sync stores the **series-level** TVDB/TMDB/IMDB
 *     ids on *every episode row* of a show (see `series-key.ts`): a bare TVDB
 *     match therefore returns the show's entire episode list. Episodes are
 *     consequently narrowed by `seasonNumber` + `episodeNumber` as well, and a
 *     record missing either is skipped outright rather than guessed at.
 *
 * The index is built once per sync with two queries. A first import can be tens
 * of thousands of records, so a per-record query is not an option.
 */

/** Why a record could not be turned into a `MediaItem.id`. */
export type TracearrJoinSkipReason =
  /** No candidate matched — the item isn't in this server's library (yet). */
  | "unresolved"
  /** Several candidates matched and none could be preferred. */
  | "ambiguous"
  /** `live`/`photo`/`trailer`/`unknown` — not a library item at all. */
  | "unsupported-type";

export type TracearrJoinResult =
  | { mediaItemId: string }
  | { skipped: TracearrJoinSkipReason };

/** The only record fields resolution needs, typed off the client so it can't drift. */
export type TracearrJoinRecord = Pick<
  TracearrHistoryRecord,
  | "media_type"
  | "rating_key"
  | "season_number"
  | "episode_number"
  | "tvdb_id"
  | "tmdb_id"
  | "imdb_id"
>;

/** A candidate row, carrying just enough to apply the narrowing constraints. */
interface JoinCandidate {
  id: string;
  type: LibraryType;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /**
   * `"<SOURCE>:<id>"` keys this item carries, used to detect a rating key that
   * now points somewhere else — see the contradiction check in
   * `resolveMediaItemId`.
   */
  providerIds: Set<string>;
}

export interface TracearrJoinIndex {
  serverId: string;
  /** `ratingKey` → candidates (an array: collisions must be detectable). */
  byRatingKey: Map<string, JoinCandidate[]>;
  /** `"<SOURCE>:<externalId>"` → candidates sharing that provider id. */
  byExternalId: Map<string, JoinCandidate[]>;
  /** For the importer's summary line. */
  itemCount: number;
  externalIdCount: number;
}

/**
 * Tracearr's `media_type` → our `LibraryType`. `live`, `photo`, `trailer` and
 * `unknown` map to nothing on purpose: none of them is a library item, so there
 * is no correct `MediaItem` for such a play. They are refused **before** the
 * `rating_key` lookup rather than after, because a live-TV or trailer session
 * carries a rating key from a different namespace than the library — an exact
 * numeric hit there would be a collision, not a match. `unknown` is refused for
 * the same reason in reverse: with no declared type we cannot verify that the
 * row we found is the right *kind* of thing.
 */
const MEDIA_TYPE_TO_LIBRARY_TYPE: Record<TracearrMediaType, LibraryType | null> =
  {
    movie: "MOVIE",
    episode: "SERIES",
    track: "MUSIC",
    live: null,
    photo: null,
    trailer: null,
    unknown: null,
  };

/** Provider precedence — identical to `computeSeriesKey`'s TVDB → TMDB → title. */
const PROVIDER_SOURCES = ["TVDB", "TMDB", "IMDB"] as const;
type ProviderSource = (typeof PROVIDER_SOURCES)[number];

/**
 * `MediaItemExternalId.source` is stored as "TVDB"/"TMDB"/"IMDB", but nothing
 * enforces that casing, so the source is matched case-insensitively — the same
 * thing `series-key.ts` does with `UPPER(e."source")`. The id *value* is only
 * trimmed, matching `findExternalId` there; a case difference in an IMDB id
 * degrades to `unresolved`, which is the safe direction.
 */
function externalIdKey(source: ProviderSource, value: string): string {
  return `${source}:${value.trim()}`;
}

/** Load every candidate row for one media server, plus its provider ids. */
export async function buildTracearrJoinIndex(
  serverId: string,
): Promise<TracearrJoinIndex> {
  const items = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      ratingKey: string;
      type: LibraryType;
      seasonNumber: number | null;
      episodeNumber: number | null;
    }>
  >(
    `SELECT mi."id", mi."ratingKey", mi."type", mi."seasonNumber", mi."episodeNumber"
       FROM "MediaItem" mi
       JOIN "Library" l ON mi."libraryId" = l."id"
      WHERE l."mediaServerId" = $1`,
    serverId,
  );

  const byId = new Map<string, JoinCandidate>();
  const byRatingKey = new Map<string, JoinCandidate[]>();

  for (const row of items) {
    const candidate: JoinCandidate = {
      id: row.id,
      type: row.type,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
      providerIds: new Set(),
    };
    byId.set(row.id, candidate);

    const existing = byRatingKey.get(row.ratingKey);
    if (existing) existing.push(candidate);
    else byRatingKey.set(row.ratingKey, [candidate]);
  }

  // Scoped to the same server (and to the three sources resolution uses) so the
  // index stays proportional to one server's library rather than the whole DB.
  const externalIds = await prisma.$queryRawUnsafe<
    Array<{ mediaItemId: string; source: string; externalId: string }>
  >(
    `SELECT e."mediaItemId", UPPER(e."source") AS "source", e."externalId"
       FROM "MediaItemExternalId" e
       JOIN "MediaItem" mi ON mi."id" = e."mediaItemId"
       JOIN "Library" l ON mi."libraryId" = l."id"
      WHERE l."mediaServerId" = $1
        AND UPPER(e."source") IN ('TVDB','TMDB','IMDB')`,
    serverId,
  );

  const byExternalId = new Map<string, JoinCandidate[]>();
  for (const row of externalIds) {
    const candidate = byId.get(row.mediaItemId);
    if (!candidate) continue;
    const value = row.externalId?.trim();
    if (!value) continue;

    // The query already normalizes with UPPER(), but normalize here too so the
    // index cannot depend on that — `findExternalId` in `series-key.ts` does
    // exactly the same belt-and-braces `toUpperCase()`.
    const key = externalIdKey(
      row.source.toUpperCase() as ProviderSource,
      value,
    );
    candidate.providerIds.add(key);

    const existing = byExternalId.get(key);
    if (existing) existing.push(candidate);
    else byExternalId.set(key, [candidate]);
  }

  return {
    serverId,
    byRatingKey,
    byExternalId,
    itemCount: items.length,
    externalIdCount: externalIds.length,
  };
}

/** The record's provider ids, in precedence order, skipping the absent ones. */
function providerIdsFor(
  record: TracearrJoinRecord,
): Array<{ source: ProviderSource; value: string }> {
  const raw: Record<ProviderSource, string | number | null> = {
    TVDB: record.tvdb_id,
    TMDB: record.tmdb_id,
    IMDB: record.imdb_id,
  };

  const ids: Array<{ source: ProviderSource; value: string }> = [];
  for (const source of PROVIDER_SOURCES) {
    const value = raw[source];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) ids.push({ source, value: text });
  }
  return ids;
}

/**
 * Narrow a provider-id candidate list to the rows the record could actually be.
 *
 * The episode constraint is the load-bearing part. Because every episode row of
 * a show carries the show's TVDB id, `candidates` for an episode record is the
 * whole series; only `seasonNumber` + `episodeNumber` single one out. Note that
 * season 0 is real (Specials) and episode numbering starts at 1 — hence the
 * explicit null checks rather than truthiness tests.
 */
function narrowCandidates(
  candidates: JoinCandidate[],
  record: TracearrJoinRecord,
  expectedType: LibraryType,
): JoinCandidate[] {
  const typeMatched = candidates.filter((c) => c.type === expectedType);
  if (record.media_type !== "episode") return typeMatched;

  return typeMatched.filter(
    (c) =>
      c.seasonNumber === record.season_number &&
      c.episodeNumber === record.episode_number,
  );
}

/**
 * Whether a candidate's provider ids actively DISAGREE with the record's.
 *
 * Only a same-source mismatch counts. An item with no ids, or a record naming a
 * source the item does not carry, tells us nothing — and refusing on silence
 * would drop most legitimate plays, since a library's provider ids are far from
 * universally populated.
 *
 * Season/episode numbers are deliberately NOT compared here, unlike on the
 * provider path: the rating key already identifies the exact episode on that
 * server, whereas Tracearr and the server can legitimately disagree about
 * numbering (absolute vs aired ordering on anime, say), so narrowing on it
 * would drop real plays to catch a case the type and provider checks already
 * cover.
 */
function contradictsProviderIds(
  candidate: JoinCandidate,
  record: TracearrJoinRecord,
): boolean {
  if (candidate.providerIds.size === 0) return false;
  for (const { source, value } of providerIdsFor(record)) {
    const key = externalIdKey(source, value);
    if (candidate.providerIds.has(key)) continue;
    // Same source, different value — the item this key now points at is not the
    // one the play was recorded against.
    const prefix = `${source}:`;
    for (const held of candidate.providerIds) {
      if (held.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Resolve one record against a prebuilt index. Never returns a "best guess" —
 * see the file header for why.
 */
export function resolveMediaItemId(
  index: TracearrJoinIndex,
  record: TracearrJoinRecord,
): TracearrJoinResult {
  const expectedType = MEDIA_TYPE_TO_LIBRARY_TYPE[record.media_type];
  if (!expectedType) return { skipped: "unsupported-type" };

  // 1. The server's own id for the item.
  const ratingKey = record.rating_key?.trim();
  if (ratingKey) {
    const hits = index.byRatingKey.get(ratingKey);
    if (hits && hits.length > 1) return { skipped: "ambiguous" };
    if (hits && hits.length === 1) {
      const hit = hits[0];
      // A rating key is the server's own id for an item, but it is NOT stable
      // across a delete: Plex reuses them (they are rowids), so a key that
      // identified a deleted film can later identify a different one. An
      // un-corroborated hit then files the old item's plays against the new
      // item — under REAL usernames, which is the dangerous direction: play
      // state is monotonic so inflating it only disarms rules, but a wrong
      // `serverUsername` ARMS a positive `watchedByUser` DELETE. And nothing
      // revisits an upserted row, so it is permanent.
      //
      // Two cheap corroborations, both of which a genuine hit passes:
      //  - the item must be the type the record says it is;
      //  - where BOTH sides carry a provider id from the same source, they must
      //    agree. Silence on either side proves nothing and is accepted, so
      //    this only rejects an actual contradiction.
      if (hit.type !== expectedType) return { skipped: "ambiguous" };
      if (contradictsProviderIds(hit, record)) return { skipped: "ambiguous" };
      return { mediaItemId: hit.id };
    }
    // Zero hits: fall through. A null/stale rating key is the normal reason a
    // real play needs the provider fallback.
  }

  // 2. Provider ids, in precedence order.
  //
  // An episode record with an unknown season or episode number cannot be
  // disambiguated at all here — the show's id alone would match every episode —
  // so it is refused before a lookup rather than resolving to a coin flip.
  if (
    record.media_type === "episode" &&
    (record.season_number == null || record.episode_number == null)
  ) {
    return { skipped: "ambiguous" };
  }

  for (const { source, value } of providerIdsFor(record)) {
    const candidates = index.byExternalId.get(externalIdKey(source, value));
    if (!candidates || candidates.length === 0) continue;

    const narrowed = narrowCandidates(candidates, record, expectedType);
    if (narrowed.length === 1) return { mediaItemId: narrowed[0].id };
    if (narrowed.length > 1) {
      // Two rows on one server sharing a provider id AND (for an episode) the
      // same season/episode. A lower-precedence provider would match the same
      // pair, so there is nothing left to try.
      return { skipped: "ambiguous" };
    }
    // Narrowed to nothing (the id belongs to a different media type, or to
    // another episode of the show): try the next provider.
  }

  return { skipped: "unresolved" };
}
