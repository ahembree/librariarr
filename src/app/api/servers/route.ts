import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { validateRequest, serverAddSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
import { eventBus } from "@/lib/events/event-bus";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { getPlexResources, getStoredPlexToken } from "@/lib/plex/auth";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";
import { apiLogger } from "@/lib/logger";
import type { SyncJob } from "@/generated/prisma/client";

/**
 * The user's media servers.
 *
 * `?fields=basic` answers `{ id, name, type, enabled }` per server and nothing
 * else — what a server picker reads (`useServers`) — without the libraries,
 * their item counts (a count over every item of the library) or the latest
 * sync jobs. Without it, the full record, as Settings reads it.
 *
 * The request is optional so the settings bundle can run this handler as it
 * runs every bundled one, with no arguments.
 */
export const GET = withSession(async (session, request?: NextRequest) => {
  if (request?.nextUrl.searchParams.get("fields") === "basic") {
    const servers = await prisma.mediaServer.findMany({
      where: { userId: session.userId },
      select: { id: true, name: true, type: true, enabled: true },
    });
    return NextResponse.json({ servers });
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId },
    include: {
      libraries: {
        select: { id: true, key: true, title: true, type: true, enabled: true, lastSyncedAt: true, _count: { select: { mediaItems: true } } },
      },
    },
  });

  const latestJobs = await latestSyncJobs(servers.map((server) => server.id));

  return NextResponse.json({
    servers: sanitize(
      servers.map((server) => {
        const job = latestJobs.get(server.id);
        return { ...server, syncJobs: job ? [job] : [] };
      }),
    ),
  });
});

/**
 * Each server's newest sync job — a RUNNING one ahead of any newer row — by
 * server id.
 *
 * Not a nested `syncJobs: { orderBy, take: 1 }` include: Prisma cannot push a
 * per-parent `take` into SQL, so that loaded every job the server had ever run
 * and dropped all but one — and nothing prunes SyncJob, so this route (behind
 * most pages) got slower for as long as the install ran.
 *
 * A running sync wins over a newer row: the library pages' Sync queues behind
 * a running sync under a PENDING row of its own, and showing that row hid the
 * running one's progress bar for as long as it ran.
 *
 * Two statements whatever the server count: one picks every server's job id
 * (two index lookups per server, through `(mediaServerId, startedAt)`), one
 * reads those rows, so they come back exactly as Prisma returns a SyncJob. It
 * was up to two sequential lookups per server, each a round trip.
 */
async function latestSyncJobs(serverIds: string[]): Promise<Map<string, SyncJob>> {
  if (serverIds.length === 0) return new Map();
  const picks = await prisma.$queryRaw<{ serverId: string; jobId: string | null }[]>`
    SELECT s.id AS "serverId", COALESCE(running.id, newest.id) AS "jobId"
    FROM unnest(${serverIds}::text[]) AS s(id)
    LEFT JOIN LATERAL (
      SELECT j.id FROM "SyncJob" j
      WHERE j."mediaServerId" = s.id AND j.status = 'RUNNING'
      ORDER BY j."startedAt" DESC LIMIT 1
    ) running ON true
    LEFT JOIN LATERAL (
      SELECT j.id FROM "SyncJob" j
      WHERE j."mediaServerId" = s.id
      ORDER BY j."startedAt" DESC LIMIT 1
    ) newest ON true`;
  const jobIds = picks.flatMap((p) => (p.jobId ? [p.jobId] : []));
  const jobs = jobIds.length > 0 ? await prisma.syncJob.findMany({ where: { id: { in: jobIds } } }) : [];
  return new Map(jobs.map((job) => [job.mediaServerId, job]));
}

export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, serverAddSchema);
  if (error) return error;

  const { name, url, machineId, tlsSkipVerify, type } = data;
  const serverType = type ?? "PLEX";

  let accessToken = data.accessToken;
  if (accessToken === undefined) {
    // A Plex server picked from discovery: the browser never sees its token
    // (`GET /api/auth/plex/servers`), so look it up here. The token goes to
    // the URL in this request — the connection test below, then every sync —
    // and for a server the account owns it can be the account's own Plex
    // token, which signs in to Librariarr. A stolen cookie must not be able to
    // send it somewhere of its choosing (see recent-login.ts).
    // Checked first: confirming who you are cannot supply a Plex account.
    const plexToken = await getStoredPlexToken(session.userId);
    if (!plexToken) {
      return NextResponse.json(
        { error: "Sign in with Plex to add a server from your Plex account" },
        { status: 400 }
      );
    }
    if (!hasRecentLogin(session)) {
      return reauthRequired(session.userId, "Adding a Plex server");
    }
    let resources;
    try {
      resources = await getPlexResources(plexToken);
    } catch (err) {
      apiLogger.error("Auth", "Failed to fetch Plex servers", { error: String(err) });
      return NextResponse.json({ error: "Failed to fetch servers from Plex" }, { status: 502 });
    }
    const resource = resources.find(
      (r) => r.clientIdentifier === machineId && r.owned && r.provides.includes("server")
    );
    if (!resource) {
      return NextResponse.json(
        { error: "That server is not one of the Plex servers this account owns" },
        { status: 404 }
      );
    }
    if (!resource.accessToken) {
      return NextResponse.json(
        { error: "Plex did not return an access token for that server. Try again." },
        { status: 502 }
      );
    }
    accessToken = resource.accessToken;
  }

  // Test connection before saving
  const client = createMediaServerClient(serverType, url, accessToken, {
    skipTlsVerify: !!tlsSkipVerify,
  });
  const result = await client.testConnection();
  if (!result.ok) {
    return NextResponse.json(
      {
        error: "Failed to connect to server",
        detail: sanitizeErrorDetail(result.error),
      },
      { status: 400 }
    );
  }

  // Check if a server with the same machineId already exists for this user
  if (machineId) {
    const existing = await prisma.mediaServer.findFirst({
      where: { userId: session.userId, machineId },
    });
    if (existing) {
      const server = await prisma.mediaServer.update({
        where: { id: existing.id },
        data: { name, url, accessToken, tlsSkipVerify: !!tlsSkipVerify },
      });
      // `resolveServerFilter` caches the server name/type map, so a rename or
      // re-point has to drop it (the /[id] routes already do this on their own
      // mutations).
      invalidateMediaCaches();
      // Reconcile the realtime WebSocket (url/token may have changed).
      eventBus.emit({ type: "server:changed", userId: session.userId, meta: { serverId: server.id } });
      return NextResponse.json({ server: sanitize(server), updated: true }, { status: 200 });
    }
  }

  const server = await prisma.mediaServer.create({
    data: {
      userId: session.userId,
      type: serverType,
      name: name || "Media Server",
      url,
      accessToken,
      machineId,
      tlsSkipVerify: !!tlsSkipVerify,
    },
  });

  // A second server flips `resolveServerFilter`'s `isSingleServer`, which
  // decides whether media listings filter to `dedupCanonical`. The cached
  // pre-add answer would otherwise stand until its TTL expired.
  invalidateMediaCaches();

  // Open a realtime WebSocket for the newly-added server.
  eventBus.emit({ type: "server:changed", userId: session.userId, meta: { serverId: server.id } });

  return NextResponse.json({ server: sanitize(server) }, { status: 201 });
});
