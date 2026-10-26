import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { checkForUpdate } from "@/lib/version/update-checker";

/**
 * The latest completed migration. The table only exists when the schema was
 * applied with `prisma migrate deploy`.
 */
async function readLatestMigration(): Promise<string> {
  const tableCheck = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = '_prisma_migrations'
    ) as exists`;
  if (!tableCheck[0]?.exists) return "N/A (db push)";
  const migrations = await prisma.$queryRaw<
    { migration_name: string; finished_at: Date }[]
  >`SELECT migration_name, finished_at FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 1`;
  return migrations[0]?.migration_name ?? "N/A (db push)";
}

export const GET = withSession(async (session, request: NextRequest) => {
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

  // `updateCheck=false` leaves out the GitHub release lookup: the Settings page
  // reads it from `/api/system/update-check` instead, so the System tab never
  // waits on GitHub.
  const includeUpdate = request.nextUrl.searchParams.get("updateCheck") !== "false";

  // Every read at once: the migration lookup, the database size and the counts
  // are independent, and ran one after another before the counts.
  const [latestMigration, databaseSize, mediaItems, enabledLibraries, totalLibraries, servers, updateInfo] =
    await Promise.all([
      readLatestMigration(),
      prisma
        .$queryRaw<{ size: string }[]>`SELECT pg_size_pretty(pg_database_size(current_database())) as size`
        .then((rows) => rows[0]?.size ?? "Unknown"),
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
});
