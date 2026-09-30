/**
 * A stolen session cookie must not be able to turn itself into a lasting way
 * in. Creating an API key on an account with no password, setting a first
 * password, and linking Plex or SSO all ask for a sign-in from the last 15
 * minutes (recent-login.ts). A Plex token signs in to Librariarr — and stamps
 * a fresh `authenticatedAt` — on its own (`POST /api/auth/plex/token`), so any
 * route that lets a stale cookie read one passes every one of those checks.
 *
 * The reported chain, from nothing but a cookie:
 *   1. `POST /api/backup` with a passphrase of the attacker's choosing,
 *   2. `GET /api/backup/[filename]`, decrypt, read `User.plexToken`,
 *   3. `POST /api/auth/plex/token` with it — a fresh sign-in,
 *   4. `POST /api/settings/api-keys` — a key that outlives the cookie.
 *
 * Two other routes handed a stale cookie the same token: discovery returned
 * each owned server's `accessToken` (which plex.tv can set to the account's
 * own token), and a server edit sent the stored token to any new URL.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { gunzipSync } from "zlib";
import { createDecipheriv, scryptSync } from "crypto";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession, getMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
} from "../../setup/test-helpers";

// file deepcode ignore HardcodedNonCryptoSecret/test: Test file with hardcoded values

// The backup service reads BACKUP_DIR when it loads, so the route handlers are
// imported below, after it is set.
const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-stolen-cookie-"));
process.env.BACKUP_DIR = backupDir;

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api-keys/notify", () => ({ notifyApiKeyChange: vi.fn() }));

const { mockGetPlexUser, mockGetPlexResources } = vi.hoisted(() => ({
  mockGetPlexUser: vi.fn(),
  mockGetPlexResources: vi.fn(),
}));
vi.mock("@/lib/plex/auth", () => ({
  getPlexUser: mockGetPlexUser,
  getPlexResources: mockGetPlexResources,
}));

// Every media-server request is made through this factory: its calls record
// which URL each token was sent to.
const { mockCreateClient, mockTestConnection } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockTestConnection: vi.fn(),
}));
vi.mock("@/lib/media-server/factory", () => ({ createMediaServerClient: mockCreateClient }));

const { POST: createBackupRoute } = await import("@/app/api/backup/route");
const { GET: downloadBackupRoute } = await import("@/app/api/backup/[filename]/route");
const { POST: restoreBackupRoute } = await import("@/app/api/backup/restore/route");
const { GET: plexServersRoute } = await import("@/app/api/auth/plex/servers/route");
const { POST: plexTokenRoute } = await import("@/app/api/auth/plex/token/route");
const { POST: addServerRoute } = await import("@/app/api/servers/route");
const { PUT: editServerRoute } = await import("@/app/api/servers/[id]/route");
const { POST: createApiKeyRoute } = await import("@/app/api/settings/api-keys/route");
const { createBackup, listBackups } = await import("@/lib/backup/backup-service");
const { RECENT_LOGIN_WINDOW_MS } = await import("@/lib/auth/recent-login");

const prisma = getTestPrisma();

const ACCOUNT_TOKEN = "plex-account-token";
const PASSPHRASE = "chosen-by-whoever-holds-the-cookie";
const ATTACKER_URL = "https://attacker.example";
const PLEX_ID = 4242;

/** The backup format (`encryptBuffer` in backup-service.ts), read back. */
function decryptBackup(data: Buffer, passphrase: string): Buffer {
  const salt = data.subarray(8, 40);
  const iv = data.subarray(40, 52);
  const tag = data.subarray(52, 68);
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(68)), decipher.final()]);
}

function urlsSentTo(): string[] {
  return mockCreateClient.mock.calls.map((call) => call[1] as string);
}

describe("a stolen session cookie cannot mint a lasting credential", () => {
  let userId: string;
  let serverId: string;
  let scheduledBackup: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    for (const file of await fs.readdir(backupDir)) {
      await fs.rm(path.join(backupDir, file), { force: true });
    }

    mockTestConnection.mockResolvedValue({ ok: true, serverName: "Home" });
    mockCreateClient.mockImplementation(() => ({ testConnection: mockTestConnection }));
    mockGetPlexUser.mockImplementation(async (token: string) => {
      if (token !== ACCOUNT_TOKEN) throw new Error("401 Unauthorized");
      return { id: PLEX_ID, username: "admin", email: "admin@example.com" };
    });
    mockGetPlexResources.mockResolvedValue([
      {
        name: "Home",
        clientIdentifier: "machine-1",
        provides: "server",
        owned: true,
        // plex.tv can answer an owned server with the account's own token.
        accessToken: ACCOUNT_TOKEN,
        connections: [
          { protocol: "http", address: "10.0.0.5", port: 32400, uri: "http://10.0.0.5:32400", local: true },
        ],
      },
    ]);

    // A Plex-only admin (no password), so creating a key asks for nothing
    // beyond a recent sign-in.
    const user = await createTestUser({ plexId: String(PLEX_ID), plexToken: ACCOUNT_TOKEN });
    userId = user.id;
    const server = await createTestServer(user.id, {
      type: "PLEX",
      url: "http://10.0.0.5:32400",
      accessToken: ACCOUNT_TOKEN,
      machineId: "machine-1",
    });
    serverId = server.id;
    // What a backup schedule leaves on disk: unencrypted when no backup
    // password is set.
    scheduledBackup = await createBackup(undefined, true);
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it("from a stale session, no route yields the Plex token, a fresh sign-in or a key", async () => {
    const stale = Date.now() - RECENT_LOGIN_WINDOW_MS - 60_000;
    setMockSession({ isLoggedIn: true, userId, plexToken: ACCOUNT_TOKEN, authenticatedAt: stale });

    // 1. A backup under a passphrase the cookie holder picks.
    const created = await expectJson<{ code: string; methods: string[] }>(
      await callRoute(createBackupRoute, {
        url: "/api/backup",
        method: "POST",
        body: { passphrase: PASSPHRASE },
      }),
      403,
    );
    expect(created.code).toBe("reauth_required");
    // Offered a way to confirm in place instead of signing out.
    expect(created.methods).toEqual(["plex"]);
    expect((await listBackups()).map((b) => b.filename)).toEqual([scheduledBackup]);

    // 2. Nor a backup already on disk.
    const downloaded = await callRouteWithParams(
      downloadBackupRoute,
      { filename: scheduledBackup },
      { url: `/api/backup/${scheduledBackup}` },
    );
    expect(downloaded.status).toBe(403);
    const refusal = await downloaded.text();
    expect(JSON.parse(refusal).code).toBe("reauth_required");
    expect(refusal).not.toContain(ACCOUNT_TOKEN);

    // A restore rewrites the account's credentials from a file.
    const restored = await expectJson<{ code: string }>(
      await callRoute(restoreBackupRoute, {
        url: "/api/backup/restore",
        method: "POST",
        body: { filename: scheduledBackup },
      }),
      403,
    );
    expect(restored.code).toBe("reauth_required");
    expect(await prisma.user.count()).toBe(1);

    // 3. Discovery still lists the servers, without their tokens.
    const discoveryResponse = await callRoute(plexServersRoute, { url: "/api/auth/plex/servers" });
    expect(discoveryResponse.status).toBe(200);
    const discovery = await discoveryResponse.text();
    expect(JSON.parse(discovery).servers).toHaveLength(1);
    expect(discovery).not.toContain(ACCOUNT_TOKEN);

    // 4. The stored token is not sent to a URL of the cookie holder's choosing,
    //    by editing the server or by adding it again under a new address.
    const edited = await expectJson<{ code: string }>(
      await callRouteWithParams(
        editServerRoute,
        { id: serverId },
        { url: `/api/servers/${serverId}`, method: "PUT", body: { url: ATTACKER_URL } },
      ),
      403,
    );
    expect(edited.code).toBe("reauth_required");
    // Disabled first, re-enabled later: no connection test, same destination.
    await expectJson(
      await callRouteWithParams(
        editServerRoute,
        { id: serverId },
        { url: `/api/servers/${serverId}`, method: "PUT", body: { url: ATTACKER_URL, enabled: false } },
      ),
      403,
    );
    const readded = await expectJson<{ code: string }>(
      await callRoute(addServerRoute, {
        url: "/api/servers",
        method: "POST",
        body: { name: "Home", url: ATTACKER_URL, machineId: "machine-1" },
      }),
      403,
    );
    expect(readded.code).toBe("reauth_required");
    expect(urlsSentTo()).not.toContain(ATTACKER_URL);
    expect((await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } })).url).toBe(
      "http://10.0.0.5:32400",
    );

    // With no token in hand the cookie never signs in again...
    expect(mockGetPlexUser).not.toHaveBeenCalled();
    expect(getMockSession().authenticatedAt).toBe(stale);

    // 5. ...so it cannot create the key.
    const key = await expectJson<{ code: string }>(
      await callRoute(createApiKeyRoute, {
        url: "/api/settings/api-keys",
        method: "POST",
        body: { name: "persistence", scopes: ["media:read"], expiresAt: null },
      }),
      403,
    );
    expect(key.code).toBe("reauth_required");
    expect(await prisma.apiKey.count()).toBe(0);
  });

  // The same requests from a session signed in moments ago: every step
  // succeeds, which is what makes the backup routes worth gating. (A recent
  // session could create the key directly anyway.)
  it("from a recent session the chain works, because a backup holds the Plex token", async () => {
    setMockSession({ isLoggedIn: true, userId, plexToken: ACCOUNT_TOKEN, authenticatedAt: Date.now() });

    const { filename } = await expectJson<{ filename: string }>(
      await callRoute(createBackupRoute, {
        url: "/api/backup",
        method: "POST",
        body: { passphrase: PASSPHRASE },
      }),
      200,
    );
    const downloaded = await callRouteWithParams(
      downloadBackupRoute,
      { filename },
      { url: `/api/backup/${filename}` },
    );
    expect(downloaded.status).toBe(200);
    const file = Buffer.from(await downloaded.arrayBuffer());
    const backup = JSON.parse(gunzipSync(decryptBackup(file, PASSPHRASE)).toString("utf-8")) as {
      data: { user: Array<{ plexToken: string }>; mediaServer: Array<{ accessToken: string }> };
    };
    const plexToken = backup.data.user[0].plexToken;
    expect(plexToken).toBe(ACCOUNT_TOKEN);
    expect(backup.data.mediaServer[0].accessToken).toBe(ACCOUNT_TOKEN);

    // The token alone is a Plex sign-in, stamping a fresh authenticatedAt.
    const before = Date.now();
    await expectJson(
      await callRoute(plexTokenRoute, {
        url: "/api/auth/plex/token",
        method: "POST",
        body: { authToken: plexToken },
      }),
      200,
    );
    expect(getMockSession().authenticatedAt).toBeGreaterThanOrEqual(before);

    await expectJson(
      await callRoute(createApiKeyRoute, {
        url: "/api/settings/api-keys",
        method: "POST",
        body: { name: "persistence", scopes: ["media:read"], expiresAt: null },
      }),
      201,
    );
    expect(await prisma.apiKey.count()).toBe(1);
  });
});
