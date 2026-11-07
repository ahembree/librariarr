/**
 * A restore insert that fails never repeats the rows it was given.
 *
 * A Prisma validation error renders the whole `createMany` argument — a batch
 * of rows, every column — into its message. Restore used to log that message
 * and throw it on to the restore routes' NDJSON, so one value that did not fit
 * the schema wrote the admin's Plex token, password hash, OIDC client secret
 * and Discord webhook into `LogEntry` (readable from `/api/system/logs`) and
 * into the browser. It now says only the table, the error's class and code,
 * and the schema names involved.
 *
 * Real createBackup → restoreBackup against the test database.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { gunzipSync, gzipSync } from "zlib";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser } from "../../setup/test-helpers";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-restore-insert-"));
process.env.BACKUP_DIR = backupDir;

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger,
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createBackup, restoreBackup } = await import("@/lib/backup/backup-service");
const prisma = getTestPrisma();

const PLEX_TOKEN = "fake-plex-token-7c1e9a";
const PASSWORD_HASH = "$2b$12$fakehashfakehashfakehash";
const OIDC_SECRET = "fake-oidc-client-secret-42";
const WEBHOOK = "https://discord.com/api/webhooks/1/fake-webhook-token";
const CREDENTIALS = [PLEX_TOKEN, PASSWORD_HASH, OIDC_SECRET, WEBHOOK];

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
  await fs.rm(backupDir, { recursive: true, force: true });
});

/** A backup of an admin carrying every credential, edited by `edit` before restore. */
async function backupWith(edit: (data: Record<string, Array<Record<string, unknown>>>) => void): Promise<string> {
  const user = await createTestUser({ plexToken: PLEX_TOKEN });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: PASSWORD_HASH } });
  await prisma.appSettings.create({
    data: { userId: user.id, oidcClientSecret: OIDC_SECRET, discordWebhookUrl: WEBHOOK },
  });
  const original = await createBackup(undefined, true);
  const backup = JSON.parse(gunzipSync(await fs.readFile(path.join(backupDir, original))).toString("utf-8"));
  edit(backup.data);
  const filename = "librariarr-backup-edited.json.gz";
  await fs.writeFile(path.join(backupDir, filename), gzipSync(JSON.stringify(backup)));
  return filename;
}

async function failureOf(filename: string): Promise<Error> {
  const failure = await restoreBackup(filename).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  return failure as Error;
}

function expectNoCredentialIn(text: string) {
  for (const credential of CREDENTIALS) expect(text).not.toContain(credential);
}

describe("restore when an insert fails", () => {
  it("names the table, the error class and the field of a row Prisma refuses, and none of its values", async () => {
    // The user row carries the Plex token and the password hash; one value
    // Prisma's DateTime input cannot read fails the whole batch.
    const filename = await backupWith((data) => {
      data.user[0].createdAt = "not a date";
    });

    const failure = await failureOf(filename);
    expect(failure.message).toBe(
      "Failed to restore table user: a row in the backup does not match the current schema " +
        "(PrismaClientValidationError, `createdAt`)",
    );
    expectNoCredentialIn(failure.message);
    expect(logger.error).toHaveBeenCalledWith("Backup", failure.message);
    expectNoCredentialIn(JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, logger.info.mock.calls]));

    // Rolled back whole.
    expect((await prisma.user.findFirstOrThrow()).plexToken).toBe(PLEX_TOKEN);
  });

  it("says the same for the settings row, which holds the OIDC client secret and the webhook", async () => {
    const filename = await backupWith((data) => {
      data.appSettings[0].localAuthEnabled = "yes";
    });

    const failure = await failureOf(filename);
    expect(failure.message).toBe(
      "Failed to restore table appSettings: a row in the backup does not match the current schema " +
        "(PrismaClientValidationError, `localAuthEnabled`)",
    );
    expectNoCredentialIn(JSON.stringify([failure.message, logger.error.mock.calls]));
  });

  // A database refusal keeps its Prisma code and the constraint, named from
  // the schema.
  it("names the code and the constraint of a row the database refuses", async () => {
    const filename = await backupWith((data) => {
      data.appSettings[0].userId = "no-such-user";
    });

    const failure = await failureOf(filename);
    expect(failure.message).toBe(
      "Failed to restore table appSettings: the database refused a row " +
        "(PrismaClientKnownRequestError P2003, `AppSettings_userId_fkey`)",
    );
    expectNoCredentialIn(JSON.stringify([failure.message, logger.error.mock.calls]));
  });
});
