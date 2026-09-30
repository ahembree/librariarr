import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import type { MediaServerType } from "@/generated/prisma/client";
import { validateRequest, serverAddSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
import { eventBus } from "@/lib/events/event-bus";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { getPlexResources } from "@/lib/plex/auth";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";
import { apiLogger } from "@/lib/logger";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId },
    include: {
      libraries: {
        select: { id: true, key: true, title: true, type: true, enabled: true, lastSyncedAt: true, _count: { select: { mediaItems: true } } },
      },
      syncJobs: {
        orderBy: { startedAt: "desc" },
        take: 1,
      },
    },
  });

  return NextResponse.json({ servers: sanitize(servers) });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, serverAddSchema);
  if (error) return error;

  const { name, url, machineId, tlsSkipVerify, type } = data;
  const serverType = (type as MediaServerType) ?? "PLEX";

  let accessToken = data.accessToken;
  if (accessToken === undefined) {
    // A Plex server picked from discovery: the browser never sees its token
    // (`GET /api/auth/plex/servers`), so look it up here. The token goes to
    // the URL in this request — the connection test below, then every sync —
    // and for a server the account owns it can be the account's own Plex
    // token, which signs in to Librariarr. A stolen cookie must not be able to
    // send it somewhere of its choosing (see recent-login.ts).
    // Checked first: confirming who you are cannot supply a Plex account.
    if (!session.plexToken) {
      return NextResponse.json(
        { error: "Sign in with Plex to add a server from your Plex account" },
        { status: 400 }
      );
    }
    if (!hasRecentLogin(session)) {
      return reauthRequired(session.userId!, "Adding a Plex server");
    }
    let resources;
    try {
      resources = await getPlexResources(session.plexToken);
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
      where: { userId: session.userId!, machineId },
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
      eventBus.emit({ type: "server:changed", userId: session.userId!, meta: { serverId: server.id } });
      return NextResponse.json({ server: sanitize(server), updated: true }, { status: 200 });
    }
  }

  const server = await prisma.mediaServer.create({
    data: {
      userId: session.userId!,
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
  eventBus.emit({ type: "server:changed", userId: session.userId!, meta: { serverId: server.id } });

  return NextResponse.json({ server: sanitize(server) }, { status: 201 });
}
