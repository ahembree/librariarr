import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { eventBus } from "@/lib/events/event-bus";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { validateRequest, serverLibraryUpdateSchema } from "@/lib/validation";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const plexLibraries = await client.getLibraries();
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
}

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
  eventBus.emit({ type: "server:changed", userId: session.userId!, meta: { serverId: server.id } });

  const updated = await prisma.library.findMany({
    where: { mediaServerId: server.id },
    select: { key: true, title: true, type: true, enabled: true },
  });

  return NextResponse.json({ libraries: updated });
}
