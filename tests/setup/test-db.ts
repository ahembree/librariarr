import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { LIST_RESPONSE_CACHE_PREFIX } from "@/lib/cache/list-response-prefix";

let _prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!_prisma) {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    });
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

let appTables: string | null = null;

/**
 * Empty every application table. The list is read from the database once, so
 * a model added later is cleaned without anyone remembering to list it here —
 * the hand-kept list had missed SystemConfig (which nothing cascades to, so
 * the Plex client id leaked from one test into the next), TracearrInstance,
 * Collection, RuleMatch, LifecycleException and WatchHistory.
 */
export async function cleanDatabase() {
  const prisma = getTestPrisma();
  if (appTables === null) {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      ORDER BY tablename`;
    appTables = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  }
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${appTables} CASCADE`);
  // The library listings' cached responses describe the rows just removed. The
  // app drops them on every media write (`invalidateMediaCaches`); a test that
  // writes rows directly has to start without them too. Reached through the
  // `globalThis` pin rather than an import, since many test files mock the
  // cache modules — and where the real cache was never made, nothing is cached.
  (globalThis as { appCache?: { invalidatePrefix(prefix: string): void } }).appCache?.invalidatePrefix(
    LIST_RESPONSE_CACHE_PREFIX,
  );
}

export async function disconnectTestDb() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}
