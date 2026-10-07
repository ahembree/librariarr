import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { apiLogger } from "@/lib/logger";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import { validateRequest, serverEditSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { eventBus } from "@/lib/events/event-bus";
import {
  invalidateWatchHistoryEvidence,
  restartTracearrBackfill,
} from "@/lib/media/watch-evidence";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";
import { supersedeTracearrImports } from "@/lib/sync/tracearr-import-activity";

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const server = await prisma.mediaServer.findFirst({
    where: { id, userId: session.userId },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const { data, error } = await validateRequest(request, serverEditSchema);
  if (error) return error;

  const { url, externalUrl, tlsSkipVerify, accessToken, enabled, deleteData, tracearrServerId } =
    data;

  // A new URL with the stored token kept sends that token to the new URL —
  // the connection test below, then every sync and the realtime socket. A
  // Plex server's token can be the Plex account's own token, which signs in
  // to Librariarr, so a stolen cookie must not be able to point it somewhere
  // of its choosing (see recent-login.ts). Turning certificate checks off is
  // the same thing by another route: the token then goes to whoever answers
  // at the URL, and the default one onboarding picks is the remote
  // plex.direct address. Sending a replacement token, or re-saving the same
  // settings (the edit form always sends the URL), needs nothing.
  const urlChanged = url !== undefined && withoutTrailingSlash(url) !== withoutTrailingSlash(server.url);
  const turnsTlsChecksOff = tlsSkipVerify === true && !server.tlsSkipVerify;
  const keepsStoredToken = accessToken === undefined || accessToken === "";
  if (server.type === "PLEX" && (urlChanged || turnsTlsChecksOff) && keepsStoredToken && !hasRecentLogin(session)) {
    return reauthRequired(
      session.userId!,
      urlChanged ? "Changing a Plex server's URL" : "Turning off certificate checks for a Plex server",
    );
  }

  // Test connection if URL or access token changed (skip if just toggling enabled)
  if ((url || accessToken) && enabled !== false) {
    const testUrl = url ?? server.url;
    // `""` keeps the stored token (the write below skips it), so test with that.
    const testToken = accessToken || server.accessToken;
    const client = createMediaServerClient(server.type, testUrl, testToken, {
      skipTlsVerify: tlsSkipVerify ?? server.tlsSkipVerify,
    });
    const result = await client.testConnection();
    if (!result.ok) {
      return NextResponse.json(
        { error: "Failed to connect to server", detail: sanitizeErrorDetail(result.error) },
        { status: 400 }
      );
    }
  }

  // The mapping is checked and written under one per-user lock, re-reading
  // both the server's own mapping and every other server's inside it.
  //
  // One Tracearr server's plays belong to one media server. Mapped to a second
  // as well, they are joined against that server's rating keys — small per-server
  // integers on Plex, so the same number names an unrelated item there, and a
  // provider id is often absent to contradict it. Those plays would land on the
  // wrong items under real usernames, permanently. Nothing in the schema
  // enforces it (a unique index added now would fail to migrate on an install
  // already holding a duplicate — which this very race could have created), so
  // the route does: checked against a snapshot read outside the lock, two PUTs
  // mapping two servers to the same id each saw the other still unmapped and
  // both succeeded.
  //
  // `tracearrMappingChanged` is computed from the in-lock read for the same
  // reason: decided on the snapshot, two PUTs re-pointing ONE server could each
  // compare against the old value — the second then skipped the wipe and the
  // backfill reset its own change needs, or wiped a mapping that had not moved.
  const outcome = await prisma.$transaction(async (tx) => {
    if (tracearrServerId !== undefined) {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('tracearr-mapping:' || $1))`,
        session.userId!,
      );
    }
    const current = await tx.mediaServer.findFirst({
      where: { id: server.id, userId: session.userId! },
      select: { tracearrServerId: true },
    });
    if (!current) return { kind: "gone" as const };

    // Did this server's watch-history source actually change? `undefined` means
    // the client never sent the field at all (leave the mapping alone), so only a
    // value that was sent AND differs from what is stored counts — re-saving the
    // same mapping must not trigger the wipe below.
    const mappingChanged =
      tracearrServerId !== undefined && tracearrServerId !== current.tracearrServerId;

    if (mappingChanged) {
      // Before the UPDATE — see the lock-order note at the wipe below. Same
      // key as `lockServerHistory` in `sync-watch-history.ts`.
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('watch-history:' || $1))`,
        server.id,
      );
    }

    if (mappingChanged && tracearrServerId) {
      const taken = await tx.mediaServer.findFirst({
        where: {
          userId: session.userId!,
          tracearrServerId,
          id: { not: server.id },
        },
        select: { name: true },
      });
      if (taken) return { kind: "taken" as const, name: taken.name };
    }

    const updated = await tx.mediaServer.update({
      where: { id: server.id },
      data: {
        ...(url !== undefined && { url }),
        ...(externalUrl !== undefined && { externalUrl: externalUrl || null }),
        ...(tlsSkipVerify !== undefined && { tlsSkipVerify }),
        ...(accessToken !== undefined && accessToken !== "" && { accessToken }),
        ...(enabled !== undefined && { enabled }),
        // `!== undefined`, never a truthy check: `null` is the meaningful
        // "unlink, go back to native history" value, and a truthy check would
        // make unlinking impossible to express.
        ...(tracearrServerId !== undefined && { tracearrServerId }),
        // A source switch wipes the server's rows below, so the backfill state
        // those rows represent has to be reset with them. Leaving it true would
        // tell the next import "the history is already fully walked" and it would
        // only ever fetch new plays — permanently missing everything before the
        // switch. Reset on any mapping change, including Tracearr → Tracearr.
        ...(mappingChanged && {
          tracearrBackfillComplete: false,
          // The rest are measured against the OLD Tracearr server's archive:
          // its history start (which the progress bar divides by), how far the
          // walk had reached, and the floor below which the forward pass had
          // already looked. Carried over, the bar would report progress through
          // a span that no longer applies, and the walks would resume at points
          // that mean nothing on the new server.
          tracearrOldestPlayAt: null,
          tracearrBackfillCursorAt: null,
          tracearrForwardFloorAt: null,
          // "Walked and found nothing" described the OLD Tracearr server; the
          // new mapping is waiting for its first walk (the status readout
          // reports a never-walked mapping as pending, not as empty).
          tracearrBackfillLastWalkAt: null,
          // The wipe below empties the history, so it is unknown from the same
          // statement that switches the source. Withdrawn only after the wipe,
          // an unlink (native, no Tracearr flag to pause it) read as established
          // over an empty history in between — and for good, if the process died
          // there.
          watchHistorySyncedAt: null,
        }),
      },
    });

    // A source switch (native <-> Tracearr, or one Tracearr server to another)
    // invalidates every WatchHistory row already stored for this server, because
    // the two sources have incompatible row models: the native sync is a
    // full-replace that leaves all of the rich Tracearr columns null, while the
    // Tracearr sync is an incremental append keyed on `sourceEventId`. Neither
    // path ever revisits the other's rows — the append model never wipes, and
    // the native full-replace only deletes rows on a *successful* fetch — so
    // without this one-shot delete the server would keep a permanent stratum of
    // stale rows from its previous source. The next sync repopulates from the
    // new one.
    //
    // In the SAME transaction as the mapping write, so the two commit or fail
    // together: run after the commit, a crash (or a failed DELETE) in between
    // left the old source's rows under the new mapping for good — and the
    // importer derives its resume boundaries from exactly those rows.
    //
    // Lock order, which is what keeps this deadlock-free: the UPDATE above has
    // already taken this server's row lock, so a Tracearr page write
    // (`writeBatch`/`deleteNativeStratum` take the row `FOR SHARE` before
    // touching WatchHistory) either committed before it — its rows are visible
    // to this DELETE — or waits for this commit and then sees the new mapping
    // and writes nothing. Neither side ever holds WatchHistory rows while
    // waiting on the other's server-row lock. The native writers' per-server
    // advisory lock is taken BEFORE the UPDATE for the same reason: they hold
    // it across their DELETE + INSERT and only ever take a KEY SHARE on the
    // server row (which the UPDATE does not conflict with), so waiting for it
    // first means a native full replace in flight finishes before the wipe
    // rather than committing rows this DELETE could not see.
    let wiped = 0;
    if (mappingChanged) {
      ({ count: wiped } = await tx.watchHistory.deleteMany({
        where: { mediaServerId: server.id },
      }));
    }
    return {
      kind: "updated" as const,
      updated,
      mappingChanged,
      wiped,
      previousTracearrServerId: current.tracearrServerId,
    };
  }, {
    // The wipe can be a server's whole history (hundreds of thousands of rows)
    // and may wait for a native full replace to finish; Prisma's 5s default
    // would abort exactly the switches that have the most to clear.
    timeout: 5 * 60_000,
    maxWait: 15_000,
  });

  if (outcome.kind === "gone") {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
  if (outcome.kind === "taken") {
    return NextResponse.json(
      {
        error: "Tracearr server already in use",
        detail: `That Tracearr server is already the watch-history source for "${outcome.name}".`,
      },
      { status: 409 }
    );
  }
  const {
    updated,
    mappingChanged: tracearrMappingChanged,
    wiped,
    previousTracearrServerId,
  } = outcome;

  if (tracearrMappingChanged) {
    // A run of the OLD mapping may still be paging (a slice, a History-page
    // Refresh): its next write will refuse, but until it ends its live
    // readout would be reported against the new mapping — counts, and a
    // backfill reach measured on a different Tracearr server's archive.
    supersedeTracearrImports(server.id);

    // Mark the server as un-evidenced until a sync refills it. An empty
    // `WatchHistory` is indistinguishable from "nobody watched anything", and
    // `watchedByUser`'s negative forms are trivially true against an empty
    // relation — so without this marker the next detection run matches the
    // WHOLE library for this server and a DELETE rule set acts on it. Covers
    // both directions: unlinking sets `tracearrServerId` to null, so the
    // Tracearr-specific flags stop describing the server precisely when its
    // history is emptiest.
    await invalidateWatchHistoryEvidence([server.id]);

    // Every watch-history-derived cache (`watch-history-filters:` among them)
    // now describes rows that no longer exist.
    invalidateMediaCaches();

    // The denormalized `MediaItem.playCount`/`lastPlayedAt` are deliberately
    // left standing, and they survive the gap: every writer of those two
    // columns is non-regressive — the watch-reconcile helpers via GREATEST /
    // Math.max, and the item upsert itself via `GREATEST_ON_UPDATE` in
    // `sync-server.ts`. That last one is what makes this safe rather than
    // merely intended: without it a full or incremental sync landing between
    // this wipe and the re-import wrote `playCount = 0` / `lastPlayedAt = null`
    // over the real values for every item only another household member had
    // watched, arming exactly the "not played in N months" DELETE rules the
    // `watchedByUser` guard below does not cover.

    apiLogger.info(
      "Auth",
      `Watch-history source for media server "${server.name}" changed ` +
        `(${previousTracearrServerId ?? "native"} -> ${tracearrServerId ?? "native"}); ` +
        `cleared ${wiped} stored watch-history rows`
    );
  }

  // Purge media data when disabling with deleteData
  if (enabled === false && deleteData) {
    const libraries = await prisma.library.findMany({
      where: { mediaServerId: server.id },
      select: { id: true },
    });
    const libraryIds = libraries.map((l) => l.id);

    if (libraryIds.length > 0) {
      await prisma.lifecycleAction.deleteMany({
        where: { mediaItem: { libraryId: { in: libraryIds } } },
      });
      await prisma.mediaItem.deleteMany({
        where: { libraryId: { in: libraryIds } },
      });
      // The item delete cascades through `WatchHistory.mediaItem`, so this
      // server's plays are gone as well. The server row itself survives a
      // disable, so it will be re-enabled and re-synced later with an empty
      // history — mark it un-evidenced so `watchedByUser` rules do not read
      // that emptiness as "nobody watched anything".
      await invalidateWatchHistoryEvidence([server.id]);
      // A Tracearr-mapped server gets its plays back from Tracearr once it is
      // re-enabled and re-synced — but only if the archive walk runs again.
      await restartTracearrBackfill([server.id]);
    }

    apiLogger.info(
      "Auth",
      `Media server "${server.name}" disabled with data purge`
    );
  }

  // Recompute canonical + invalidate caches whenever the enabled state changes:
  // enabling/disabling a server changes the enabled-server set that dedup
  // canonical selection is computed over, so items whose canonical lived on the
  // toggled server must be re-canonicalized to a still-enabled copy (otherwise
  // they vanish from multi-server listings). Also covers the delete-data path.
  if (enabled !== undefined) {
    await recomputeCanonical(session.userId!);
    invalidateMediaCaches();
  }

  // Reconcile the realtime WebSocket: an enable/disable, url/token, or TLS
  // change all affect whether/how we connect to this server.
  eventBus.emit({ type: "server:changed", userId: session.userId!, meta: { serverId: server.id } });

  return NextResponse.json({ server: sanitize(updated) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const server = await prisma.mediaServer.findFirst({
    where: { id, userId: session.userId },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const deleteData = searchParams.get("deleteData") === "true";
  const userId = session.userId!;

  // Query libraries before server deletion (needed for lifecycle cleanup in both paths;
  // after deletion the SetNull cascade clears mediaServerId so we can't identify them)
  const libraries = await prisma.library.findMany({
    where: { mediaServerId: server.id },
    select: { id: true },
  });
  const libraryIds = libraries.map((l) => l.id);

  if (deleteData && libraryIds.length > 0) {
    // Delete all synced data: libraries, media items, and related records
    await prisma.lifecycleAction.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } } },
    });
    await prisma.mediaStream.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } } },
    });
    await prisma.mediaItemExternalId.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } } },
    });
    await prisma.mediaItem.deleteMany({
      where: { libraryId: { in: libraryIds } },
    });
    await prisma.library.deleteMany({
      where: { id: { in: libraryIds } },
    });
  }

  // Delete sync jobs and the server record.
  // Libraries with onDelete: SetNull will have mediaServerId set to null
  // if deleteData was false, preserving the library and media item data.
  await prisma.syncJob.deleteMany({ where: { mediaServerId: server.id } });
  await prisma.mediaServer.delete({ where: { id: server.id } });

  // Remove the deleted server from all lifecycle rule sets' serverIds arrays
  await prisma.$executeRawUnsafe(
    `UPDATE "RuleSet" SET "serverIds" = array_remove("serverIds", $1) WHERE $1 = ANY("serverIds") AND "userId" = $2`,
    server.id,
    userId
  );

  // Clean up stale matches and pending actions for items from the deleted server's libraries
  // (covers both orphaned rule sets and multi-server rule sets that still have other servers)
  if (libraryIds.length > 0 && !deleteData) {
    await prisma.lifecycleAction.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } }, status: "PENDING" },
    });
    await prisma.ruleMatch.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } } },
    });
  }

  // For rule sets that lost ALL servers, also clean up any remaining matches/actions
  // (catches edge cases like actions with null mediaItemId from prior orphaning)
  const orphanedRuleSets = await prisma.ruleSet.findMany({
    where: { userId, serverIds: { equals: [] } },
    select: { id: true },
  });
  if (orphanedRuleSets.length > 0) {
    const ruleSetIds = orphanedRuleSets.map((rs) => rs.id);
    await prisma.lifecycleAction.deleteMany({
      where: { ruleSetId: { in: ruleSetIds }, status: "PENDING" },
    });
    await prisma.ruleMatch.deleteMany({
      where: { ruleSetId: { in: ruleSetIds } },
    });
  }

  apiLogger.info("Auth", `Media server "${server.name}" removed (deleteData=${deleteData})`);

  // Invalidate caches that depend on server/media data
  invalidateMediaCaches();

  // Recompute canonical flags for remaining items
  await recomputeCanonical(userId);

  // Close the realtime WebSocket for the removed server.
  eventBus.emit({ type: "server:changed", userId, meta: { serverId: server.id } });

  return NextResponse.json({ success: true });
}
