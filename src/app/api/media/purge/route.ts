import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const type = searchParams.get("type");

  if (!type || !["MOVIE", "SERIES", "MUSIC"].includes(type)) {
    return NextResponse.json(
      { error: "Invalid type. Must be MOVIE, SERIES, or MUSIC" },
      { status: 400 }
    );
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId, enabled: true },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);

  if (serverIds.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  const libraries = await prisma.library.findMany({
    where: {
      mediaServerId: { in: serverIds },
      type: type as "MOVIE" | "SERIES" | "MUSIC",
    },
    select: { id: true },
  });
  const libraryIds = libraries.map((l) => l.id);

  if (libraryIds.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  const result = await prisma.mediaItem.deleteMany({
    where: { libraryId: { in: libraryIds } },
  });

  apiLogger.info(
    "Media",
    `Purged ${result.count} ${type} media items from ${libraryIds.length} libraries`
  );

  return NextResponse.json({ deleted: result.count });
}
