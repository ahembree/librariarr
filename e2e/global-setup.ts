import { execSync } from "node:child_process";
import { Client } from "pg";

/**
 * Runs once before the whole E2E run. Ensures the e2e database has the current
 * schema and starts from a clean slate (no users → the app reports
 * `setupRequired`, so the auth.setup project can drive the real first-run flow).
 */
async function globalSetup() {
  const databaseUrl =
    process.env.E2E_DATABASE_URL ??
    "postgresql://librariarr:librariarr@localhost:5432/librariarr_e2e";

  // 1. Bring the schema up to date (idempotent; safe if already in sync).
  //    Prisma 7 + prisma.config.ts: pass the URL via --url, and `db push` does
  //    not accept --skip-generate.
  execSync(`pnpm exec prisma db push --url "${databaseUrl}" --accept-data-loss`, {
    stdio: "inherit",
  });

  // 2. Truncate every application table for a deterministic clean run.
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    if (rows.length > 0) {
      const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

export default globalSetup;
