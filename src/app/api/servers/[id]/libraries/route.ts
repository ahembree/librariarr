import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { eventBus } from "@/lib/events/event-bus";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { validateRequest, serverLibraryUpdateSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { apiLogger } from "@/lib/logger";

/**
 * The answer when the media server cannot list its libraries (offline, a
 * rejected token, a 5xx). The client throws the raw AxiosError; left to escape
 * the handler it became a bare 500 and a dump of the request — headers and
 * all — in the container log.
 */
function librariesUnavailable(serverName: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  apiLogger.warn("Servers", `Could not list libraries on "${serverName}"`, { error: message });
  return NextResponse.json(
    { error: "Could not load libraries from the media server", detail: sanitizeErrorDetail(message) },
    { status: 502 },
  );
}

export const GET = withSession(async (
  session,
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const server = await prisma.mediaServer.findFirst({
    where: { id, userId: session.userId },
    include: { libraries: true },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const client = createMediaServerClient(server.type, server.url, server.accessToken, {
    skipTlsVerify: server.tlsSkipVerify,
  });

  let plexLibraries: Awaited<ReturnType<typeof client.getLibraries>>;
  try {
    plexLibraries = await client.getLibraries();
  } catch (error) {
    return librariesUnavailable(server.name, error);
  }
  const existingByKey = new Map(
    server.libraries.map((lib) => [lib.key, lib])
  );

  const libraries = plexLibraries.map((plib) => {
    const existing = existingByKey.get(plib.key);
    return {
      key: plib.key,
      title: plib.title,
      type: plib.type === "movie" ? "MOVIE" : plib.type === "artist" ? "MUSIC" : "SERIES",
      enabled: existing?.enabled ?? false,
      exists: !!existing,
    };
  });

  return NextResponse.json({ libraries });
});

export const PUT = withSession(async (
  session,
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const server = await prisma.mediaServer.findFirst({
    where: { id, userId: session.userId },
    include: { libraries: true },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const { data, error } = await validateRequest(request, serverLibraryUpdateSchema);
  if (error) return error;

  const { libraries } = data;

  const existingByKey = new Map(
    server.libraries.map((lib) => [lib.key, lib])
  );

  // The server's library list, asked for once — on the first library this
  // request has no row for, and only then. It was fetched again for every such
  // library, so enabling five new libraries made five identical requests.
  let serverLibraries: ReturnType<ReturnType<typeof createMediaServerClient>["getLibraries"]> | null = null;
  const loadServerLibraries = () =>
    (serverLibraries ??= createMediaServerClient(server.type, server.url, server.accessToken, {
      skipTlsVerify: server.tlsSkipVerify,
    }).getLibraries());

  // Asked for before any write, when it will be needed: a server that cannot
  // answer then changes nothing, instead of failing halfway through the list.
  if (libraries.some(({ key }) => !existingByKey.has(key))) {
    try {
      await loadServerLibraries();
    } catch (error) {
      return librariesUnavailable(server.name, error);
    }
  }

  for (const { key, enabled } of libraries) {
    const existing = existingByKey.get(key);
    if (existing) {
      await prisma.library.update({
        where: { id: existing.id },
        data: { enabled },
      });
    } else {
      // Pre-create library record so enabled state is persisted before first sync
      // We need title and type — fetch from server
      const plexLibraries = await loadServerLibraries();
      const plib = plexLibraries.find((l) => l.key === key);
      if (plib) {
        await prisma.library.create({
          data: {
            mediaServerId: server.id,
            key,
            title: plib.title,
            type: plib.type === "movie" ? "MOVIE" : plib.type === "artist" ? "MUSIC" : "SERIES",
            enabled,
          },
        });
      }
    }
  }

  // A library turned on or off changes what every listing and figure holds —
  // here, and in the browser, whose list cache drops on `server:changed`.
  invalidateMediaCaches();
  eventBus.emit({ type: "server:changed", userId: session.userId, meta: { serverId: server.id } });

  const updated = await prisma.library.findMany({
    where: { mediaServerId: server.id },
    select: { key: true, title: true, type: true, enabled: true },
  });

  return NextResponse.json({ libraries: updated });
});
