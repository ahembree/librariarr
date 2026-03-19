import { execSync } from "child_process";
import pg from "pg";

const TEST_DB_NAME = "librariarr_test";
const BASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://librariarr:librariarr@localhost:5432";

export async function setup() {
  const adminUrl = `${BASE_URL}/postgres`;
  const testDbUrl = `${BASE_URL}/${TEST_DB_NAME}`;

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();

  // Terminate existing connections to the test DB
  await client.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid()
  `);
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
  await client.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  await client.end();

  // Push schema to test database (Prisma 7: use --url flag, no --skip-generate)
  execSync(`npx prisma db push --url "${testDbUrl}" --accept-data-loss`, {
    stdio: "pipe",
    env: { ...process.env },
    cwd: process.cwd(),
  });
}

export async function teardown() {
  const adminUrl = `${BASE_URL}/postgres`;

  try {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid()
    `);
    await client.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await client.end();
  } catch {
    // Best effort cleanup
  }
}
