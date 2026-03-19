import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  const type = searchParams.get("type");
  const seriesScope = searchParams.get("seriesScope") === "true";

  if (!q || q.length === 0) {
    return NextResponse.json({ items: [] });
  }
  if (!type || !["MOVIE", "SERIES", "MUSIC"].includes(type)) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServer: { userId: session.userId } },
    type: type as "MOVIE" | "SERIES" | "MUSIC",
  };

  if (type === "MOVIE") {
    where.title = { contains: q, mode: "insensitive" };
  } else if (seriesScope) {
    // Series/music with scope: only search by parentTitle (series/artist name)
    where.parentTitle = { contains: q, mode: "insensitive" };
  } else {
    // Series/music without scope: search by title and parentTitle
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { parentTitle: { contains: q, mode: "insensitive" } },
    ];
  }

  const items = await prisma.mediaItem.findMany({
    where,
    select: {
      id: true,
      title: true,
      parentTitle: true,
      year: true,
      thumbUrl: true,
      type: true,
      libraryId: true,
    },
    orderBy: { title: "asc" },
    take: seriesScope && type !== "MOVIE" ? 100 : 10,
  });

  // For series/music with scope, deduplicate by parentTitle
  if (seriesScope && type !== "MOVIE") {
    const seen = new Map<string, (typeof items)[0]>();
    for (const item of items) {
      const key = item.parentTitle ?? item.title;
      if (!seen.has(key)) {
        seen.set(key, item);
      }
    }
    return NextResponse.json({ items: [...seen.values()].slice(0, 10) });
  }

  return NextResponse.json({ items });
}
