import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { TautulliClient, type TautulliHistoryRow, type TautulliStreamData } from "@/lib/tautulli/client";

// A Tautulli play and the Plex history row for the same play log their stop time
// a little apart; correlate when within this window (and same item + user).
const CORRELATION_WINDOW_MS = 5 * 60 * 1000;
// Page size for get_history.
const PAGE_LENGTH = 1000;
// Safety cap on pages per run (single-household histories are far smaller).
const MAX_PAGES = 200;

type EnrichmentData = {
  startedAt: Date | null;
  stoppedAt: Date | null;
  playDurationSec: number | null;
  pausedCounter: number | null;
  percentComplete: number | null;
  ipAddress: string | null;
  location: string | null;
  player: string | null;
  product: string | null;
  transcodeDecision: string | null;
  videoDecision: string | null;
  audioDecision: string | null;
  subtitleDecision: string | null;
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  sourceContainer: string | null;
  sourceVideoResolution: string | null;
  sourceVideoDynamicRange: string | null;
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
  streamContainer: string | null;
  streamSubtitleCodec: string | null;
  streamVideoResolution: string | null;
  streamVideoBitrate: number | null;
  streamAudioBitrate: number | null;
  streamBitrate: number | null;
  streamVideoDynamicRange: string | null;
  transcodeHwDecode: string | null;
  transcodeHwEncode: string | null;
};

function buildEnrichment(row: TautulliHistoryRow, stream: TautulliStreamData | null): EnrichmentData {
  return {
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    playDurationSec: row.playDurationSec,
    pausedCounter: row.pausedCounter,
    percentComplete: row.percentComplete,
    ipAddress: row.ipAddress,
    location: row.location,
    player: row.player,
    product: row.product,
    transcodeDecision: row.transcodeDecision,
    videoDecision: stream?.videoDecision ?? row.videoDecision,
    audioDecision: stream?.audioDecision ?? row.audioDecision,
    subtitleDecision: stream?.subtitleDecision ?? null,
    sourceVideoCodec: stream?.sourceVideoCodec ?? null,
    sourceAudioCodec: stream?.sourceAudioCodec ?? null,
    sourceContainer: stream?.sourceContainer ?? null,
    sourceVideoResolution: stream?.sourceVideoResolution ?? null,
    sourceVideoDynamicRange: stream?.sourceVideoDynamicRange ?? null,
    streamVideoCodec: stream?.streamVideoCodec ?? null,
    streamAudioCodec: stream?.streamAudioCodec ?? null,
    streamContainer: stream?.streamContainer ?? null,
    streamSubtitleCodec: stream?.streamSubtitleCodec ?? null,
    streamVideoResolution: stream?.streamVideoResolution ?? null,
    streamVideoBitrate: stream?.streamVideoBitrate ?? null,
    streamAudioBitrate: stream?.streamAudioBitrate ?? null,
    streamBitrate: stream?.streamBitrate ?? null,
    streamVideoDynamicRange: stream?.streamVideoDynamicRange ?? null,
    transcodeHwDecode: stream?.transcodeHwDecode ?? null,
    transcodeHwEncode: stream?.transcodeHwEncode ?? null,
  };
}

/** Best-effort parse of a Plex guid into a (source, externalId) pair for fallback matching. */
function parseGuid(guid: string | null): { source: string; externalId: string } | null {
  if (!guid) return null;
  const tvdb = guid.match(/thetvdb:\/\/(\d+)/i) || guid.match(/tvdb:\/\/(\d+)/i);
  if (tvdb) return { source: "tvdb", externalId: tvdb[1] };
  const tmdb = guid.match(/themoviedb:\/\/(\d+)/i) || guid.match(/tmdb:\/\/(\d+)/i);
  if (tmdb) return { source: "tmdb", externalId: tmdb[1] };
  const imdb = guid.match(/imdb:\/\/(tt\d+)/i);
  if (imdb) return { source: "imdb", externalId: imdb[1] };
  return null;
}

/**
 * Ingest Tautulli watch history for a media server and stitch it together with
 * the Plex stream data already stored.
 *
 * Behavior (per the agreed model):
 *  - One logical play per row. A Tautulli row that correlates to an existing
 *    native (Plex) row — same mediaItem + user, stop time within the window —
 *    is **merged** into that row (source → "<TYPE>+TAUTULLI").
 *  - A Tautulli row with no correlation is kept as its **own** row
 *    (source = "TAUTULLI"); both Plex-only and Tautulli-only rows coexist.
 *  - Idempotent on Tautulli `row_id`; re-runs refresh in place.
 *  - `grouping=1` collapses pause-split segments into one logical play.
 *  - Transcoded plays are enriched with get_stream_data (source→delivered);
 *    direct plays skip that extra call.
 */
export async function syncTautulliHistory(serverId: string): Promise<{ count: number }> {
  const instance = await prisma.tautulliInstance.findFirst({
    where: { mediaServerId: serverId, enabled: true },
  });
  if (!instance) {
    return { count: 0 };
  }

  const client = new TautulliClient(instance.url, instance.apiKey);

  // Incremental window: resync from the latest Tautulli stop we have, minus a
  // day of overlap to catch late-finalized rows. First run pulls everything.
  const latest = await prisma.watchHistory.findFirst({
    where: { mediaServerId: serverId, tautulliRowId: { not: null } },
    orderBy: { stoppedAt: "desc" },
    select: { stoppedAt: true },
  });
  let after: string | undefined;
  if (latest?.stoppedAt) {
    const d = new Date(latest.stoppedAt.getTime() - 24 * 60 * 60 * 1000);
    after = d.toISOString().slice(0, 10);
  }

  // ratingKey -> mediaItemId for this server (primary correlation path).
  const mediaItems = await prisma.$queryRawUnsafe<{ id: string; ratingKey: string }[]>(
    `SELECT mi."id", mi."ratingKey" FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l."id"
     WHERE l."mediaServerId"=$1`,
    serverId
  );
  const ratingKeyToId = new Map<string, string>();
  for (const m of mediaItems) ratingKeyToId.set(m.ratingKey, m.id);

  // Existing Tautulli rows (idempotent re-sync) keyed by row_id.
  const existingTautulli = await prisma.watchHistory.findMany({
    where: { mediaServerId: serverId, tautulliRowId: { not: null } },
    select: { id: true, tautulliRowId: true },
  });
  const byTautulliRowId = new Map<string, string>();
  for (const r of existingTautulli) {
    if (r.tautulliRowId) byTautulliRowId.set(r.tautulliRowId, r.id);
  }

  // Candidate native rows for correlation (no Tautulli linkage yet).
  const nativeRows = await prisma.watchHistory.findMany({
    where: { mediaServerId: serverId, tautulliRowId: null },
    select: { id: true, mediaItemId: true, serverUsername: true, watchedAt: true },
  });
  const candidates = new Map<string, { id: string; time: number }[]>();
  for (const r of nativeRows) {
    if (!r.watchedAt) continue;
    const key = `${r.mediaItemId}|${r.serverUsername}`;
    const list = candidates.get(key) ?? [];
    list.push({ id: r.id, time: r.watchedAt.getTime() });
    candidates.set(key, list);
  }
  const claimed = new Set<string>();

  // Tautulli monitors a Plex server, so a correlated row is a Plex+Tautulli merge.
  const mergedSource = "PLEX+TAUTULLI";

  let processed = 0;
  let unmatched = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows } = await client.getHistory({
      after,
      start: page * PAGE_LENGTH,
      length: PAGE_LENGTH,
      grouping: 1,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!row.rowId) continue;

      // Resolve the media item: ratingKey → grandparentRatingKey → guid.
      let mediaItemId =
        (row.ratingKey ? ratingKeyToId.get(row.ratingKey) : undefined) ??
        (row.grandparentRatingKey ? ratingKeyToId.get(row.grandparentRatingKey) : undefined);
      if (!mediaItemId) {
        const parsed = parseGuid(row.guid);
        if (parsed) {
          const ext = await prisma.mediaItemExternalId.findFirst({
            where: {
              source: parsed.source,
              externalId: parsed.externalId,
              mediaItem: { library: { mediaServerId: serverId } },
            },
            select: { mediaItemId: true },
          });
          mediaItemId = ext?.mediaItemId;
        }
      }
      if (!mediaItemId) {
        unmatched++;
        continue;
      }

      // Lazily fetch source→delivered detail only for non-direct-play sessions.
      let stream: TautulliStreamData | null = null;
      if (row.transcodeDecision && row.transcodeDecision !== "direct play") {
        try {
          stream = await client.getStreamData(row.rowId);
        } catch (err) {
          logger.debug("Tautulli", `get_stream_data failed for row ${row.rowId}`, { error: String(err) });
        }
      }
      const enrichment = buildEnrichment(row, stream);

      // 1) Idempotent re-sync of a row we already ingested.
      const existingId = byTautulliRowId.get(row.rowId);
      if (existingId) {
        await prisma.watchHistory.update({
          where: { id: existingId },
          data: { tautulliReferenceId: row.referenceId, ...enrichment },
        });
        processed++;
        continue;
      }

      // 2) Correlate to an existing native (Plex) row → merge.
      const playTime = (row.stoppedAt ?? row.watchedAt)?.getTime();
      const key = `${mediaItemId}|${row.user}`;
      let mergedInto: string | null = null;
      if (playTime != null) {
        const list = candidates.get(key);
        if (list) {
          let best: { id: string; time: number } | null = null;
          for (const c of list) {
            if (claimed.has(c.id)) continue;
            const delta = Math.abs(c.time - playTime);
            if (delta <= CORRELATION_WINDOW_MS && (!best || delta < Math.abs(best.time - playTime))) {
              best = c;
            }
          }
          if (best) {
            claimed.add(best.id);
            mergedInto = best.id;
          }
        }
      }

      if (mergedInto) {
        await prisma.watchHistory.update({
          where: { id: mergedInto },
          data: {
            source: mergedSource,
            tautulliRowId: row.rowId,
            tautulliReferenceId: row.referenceId,
            serverUsername: row.user,
            ...enrichment,
          },
        });
        byTautulliRowId.set(row.rowId, mergedInto);
        processed++;
        continue;
      }

      // 3) No correlation → keep as its own Tautulli-only row (idempotent upsert).
      const created = await prisma.watchHistory.upsert({
        where: { mediaServerId_tautulliRowId: { mediaServerId: serverId, tautulliRowId: row.rowId } },
        create: {
          mediaItemId,
          mediaServerId: serverId,
          serverUsername: row.user,
          watchedAt: row.stoppedAt ?? row.watchedAt,
          platform: row.platform,
          source: "TAUTULLI",
          tautulliRowId: row.rowId,
          tautulliReferenceId: row.referenceId,
          ...enrichment,
        },
        update: { tautulliReferenceId: row.referenceId, ...enrichment },
        select: { id: true },
      });
      byTautulliRowId.set(row.rowId, created.id);
      processed++;
    }

    if (rows.length < PAGE_LENGTH) break;
  }

  logger.info(
    "Tautulli",
    `Synced ${processed} Tautulli history entries for "${instance.name}" (${unmatched} unmatched)`
  );
  return { count: processed };
}
