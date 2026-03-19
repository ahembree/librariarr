import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
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

  const sf = await resolveServerFilter(session.userId!, serverId, "MUSIC");
  if (!sf) {
    return NextResponse.json({ letters: [] });
  }

  const cacheKey = `letters:music:${session.userId}:${serverId ?? "all"}:${search ?? ""}`;
  const cached = appCache.get<string[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ letters: cached });
  }

  // Use raw SQL for efficiency — get distinct first letters from grouped parentTitle
  const filters: string[] = [];
  const params: unknown[] = [sf.serverIds];
  let paramIdx = 2;

  if (search) {
    filters.push(`AND mi."parentTitle" ILIKE '%' || $${paramIdx} || '%'`);
    params.push(search);
    paramIdx++;
  }

  if (!sf.isSingleServer) {
    filters.push(`AND mi."dedupCanonical" = true`);
  }

  const extraFilters = filters.join("\n    ");

  const rows = await prisma.$queryRawUnsafe<{ letter: string }[]>(
    `SELECT DISTINCT
      CASE
        WHEN UPPER(LEFT(TRIM(mi."parentTitle"), 1)) BETWEEN 'A' AND 'Z'
        THEN UPPER(LEFT(TRIM(mi."parentTitle"), 1))
        ELSE '#'
      END AS letter
    FROM "MediaItem" mi
    JOIN "Library" l ON mi."libraryId" = l.id
    WHERE mi.type = 'MUSIC'::"LibraryType"
      AND mi."parentTitle" IS NOT NULL
      AND l."mediaServerId" = ANY($1::text[])
      ${extraFilters}
    ORDER BY letter`,
    ...params,
  );

  const letters = rows.map((r) => r.letter).sort((a, b) => {
    if (a === "#") return -1;
    if (b === "#") return 1;
    return a.localeCompare(b);
  });

  appCache.set(cacheKey, letters, 60_000);

  return NextResponse.json({ letters });
}
