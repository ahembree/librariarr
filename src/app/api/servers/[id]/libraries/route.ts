import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
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
      const client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });
      const plexLibraries = await client.getLibraries();
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

  const updated = await prisma.library.findMany({
    where: { mediaServerId: server.id },
    select: { key: true, title: true, type: true, enabled: true },
  });

  return NextResponse.json({ libraries: updated });
}
