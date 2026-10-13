import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { checkForUpdate } from "@/lib/version/update-checker";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

  // Latest completed migration (table only exists when using `prisma migrate deploy`)
  let latestMigration = "N/A (db push)";
  const tableCheck = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = '_prisma_migrations'
    ) as exists`;
  if (tableCheck[0]?.exists) {
    const migrations = await prisma.$queryRaw<
      { migration_name: string; finished_at: Date }[]
    >`SELECT migration_name, finished_at FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1`;
    if (migrations[0]) {
      latestMigration = migrations[0].migration_name;
    }
  }

  // Database size
  const dbSize = await prisma.$queryRaw<
    { size: string }[]
  >`SELECT pg_size_pretty(pg_database_size(current_database())) as size`;
  const databaseSize = dbSize[0]?.size ?? "Unknown";

  // `updateCheck=false` leaves out the GitHub release lookup: the Settings page
  // reads it from `/api/system/update-check` instead, so the System tab never
  // waits on GitHub.
  const includeUpdate = request.nextUrl.searchParams.get("updateCheck") !== "false";

  // Stats
  const [mediaItems, enabledLibraries, totalLibraries, servers, updateInfo] = await Promise.all([
    prisma.mediaItem.count(),
    prisma.library.count({ where: { enabled: true } }),
    prisma.library.count(),
    prisma.mediaServer.count(),
    includeUpdate ? checkForUpdate() : undefined,
  ]);

  return NextResponse.json({
    appVersion,
    latestMigration,
    databaseSize,
    stats: { mediaItems, enabledLibraries, totalLibraries, servers },
    updateInfo,
  });
}
