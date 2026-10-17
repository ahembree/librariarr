import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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
}

export async function disconnectTestDb() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}
