import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { applyCommonFilters, applyStartsWithFilter } from "@/lib/filters/build-where";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { appCache } from "@/lib/cache/memory-cache";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search");
  const serverId = searchParams.get("serverId");
  const startsWith = searchParams.get("startsWith");

  const sf = await resolveServerFilter(session.userId!, serverId, "MOVIE");
  if (!sf) {
    return NextResponse.json({ letters: [] });
  }

  // Build cache key from filter params
  const cacheKey = `letters:movies:${session.userId}:${serverId ?? "all"}:${search ?? ""}:${startsWith ?? ""}:${searchParams.toString()}`;
  const cached = appCache.get<string[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ letters: cached });
  }

  const where: Prisma.MediaItemWhereInput = {
    library: { mediaServerId: { in: sf.serverIds } },
    type: "MOVIE",
  };

  if (search) where.title = { contains: search, mode: "insensitive" };
  if (startsWith) applyStartsWithFilter(where, "title", startsWith);
  applyCommonFilters(where, searchParams);

  if (!sf.isSingleServer) {
    where.dedupCanonical = true;
  }

  const items = await prisma.mediaItem.findMany({
    where,
    select: { title: true },
    distinct: ["title"],
  });

  const letterSet = new Set<string>();
  for (const item of items) {
    if (!item.title) continue;
    const first = item.title.trim().charAt(0).toUpperCase();
    letterSet.add(first >= "A" && first <= "Z" ? first : "#");
  }

  const letters = Array.from(letterSet).sort((a, b) => {
    if (a === "#") return -1;
    if (b === "#") return 1;
    return a.localeCompare(b);
  });

  appCache.set(cacheKey, letters, 60_000);

  return NextResponse.json({ letters });
}
