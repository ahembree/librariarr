/**
 * Changes to how the instance is signed into, where its credentials go and
 * what it keeps on record each leave an `Audit` log line carrying the client
 * address — and never a secret. They used to be silent: a stolen cookie could
 * re-point the Discord webhook or switch off the API-key alert and leave
 * nothing to find.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestRadarrInstance,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockTestConnection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockTestConnection };
  }),
}));
vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockTestConnection };
  }),
}));

import { apiLogger } from "@/lib/logger";
import { PUT as discordPut } from "@/app/api/settings/discord/route";
import { PUT as aiPut } from "@/app/api/settings/ai/route";
import { PUT as logRetentionPut } from "@/app/api/settings/log-retention/route";
import { PUT as authPut } from "@/app/api/settings/auth/route";
import { PUT as ssoPut } from "@/app/api/settings/sso/route";
import { POST as radarrPost } from "@/app/api/integrations/radarr/route";
import { PUT as radarrPut, DELETE as radarrDelete } from "@/app/api/integrations/radarr/[id]/route";
import { POST as serversPost } from "@/app/api/servers/route";
import { PUT as serverPut } from "@/app/api/servers/[id]/route";
import { GET as backupGet, DELETE as backupDelete } from "@/app/api/backup/[filename]/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";

const prisma = getTestPrisma();
const ADDRESS = "198.51.100.40";
const FROM = { "x-forwarded-for": ADDRESS };

/** Every `Audit` line written, as [message, meta]. */
const audit = () =>
  vi
    .mocked(apiLogger.info)
    .mock.calls.filter(([source]) => source === "Audit")
    .map(([, message, meta]) => [message, meta]);

let userId: string;

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  mockTestConnection.mockResolvedValue({ ok: true, serverName: "Test" });
  userId = (await createTestUser({ plexId: "1" })).id;
  setMockSession({ isLoggedIn: true, userId, authenticatedAt: Date.now() });
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("security-relevant changes are logged", () => {
  it("Discord: that the webhook moved and the API-key alert's state, never the URL", async () => {
    const webhook = "https://discord.com/api/webhooks/123/SECRET-TOKEN";
    await expectJson(
      await callRoute(discordPut, { method: "PUT", headers: FROM, body: { webhookUrl: webhook, notifyApiKeys: false } }),
    );

    expect(audit()).toEqual([
      [
        "Discord notification settings changed",
        { address: ADDRESS, webhookChanged: true, webhookSet: true, notifyApiKeys: false, notifyMaintenance: false },
      ],
    ]);
    expect(JSON.stringify(vi.mocked(apiLogger.info).mock.calls)).not.toContain("SECRET-TOKEN");
  });

  it("AI: provider, and that the base URL and key moved, never their values", async () => {
    await expectJson(
      await callRoute(aiPut, {
        method: "PUT",
        headers: FROM,
        body: { provider: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKey: "sk-SECRET", model: "m" },
      }),
    );

    expect(audit()).toEqual([
      [
        "AI assistant settings changed",
        { address: ADDRESS, enabled: false, provider: "openai-compatible", baseUrlChanged: true, keyChanged: true },
      ],
    ]);
    expect(JSON.stringify(vi.mocked(apiLogger.info).mock.calls)).not.toContain("sk-SECRET");
  });

  it("log retention", async () => {
    await expectJson(await callRoute(logRetentionPut, { method: "PUT", headers: FROM, body: { logRetentionDays: 1 } }));
    expect(audit()).toEqual([["Log retention set to 1 day(s)", { address: ADDRESS }]]);
  });

  it("sign-in methods", async () => {
    await prisma.appSettings.create({ data: { userId, localAuthEnabled: false, plexLoginEnabled: true } });
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: "hash", localUsername: "admin" } });

    await expectJson(await callRoute(authPut, { method: "PUT", headers: FROM, body: { localAuthEnabled: true } }));

    expect(audit()).toEqual([
      ["Sign-in methods changed", { address: ADDRESS, localAuthEnabled: true, plexLoginEnabled: true }],
    ]);
  });

  it("SSO: the mode and issuer, never the client secret", async () => {
    await prisma.appSettings.create({ data: { userId } });

    await expectJson(
      await callRoute(ssoPut, {
        method: "PUT",
        headers: FROM,
        body: {
          ssoMode: "OIDC",
          oidcIssuer: "https://idp.example.com",
          oidcClientId: "client",
          oidcClientSecret: "OIDC-SECRET",
        },
      }),
    );

    expect(audit()).toEqual([
      ["SSO settings changed", { address: ADDRESS, ssoEnabled: false, ssoMode: "OIDC", issuer: "https://idp.example.com" }],
    ]);
    expect(JSON.stringify(vi.mocked(apiLogger.info).mock.calls)).not.toContain("OIDC-SECRET");
  });

  it("integrations: added, updated and removed, never the key or URL", async () => {
    const created = await expectJson<{ instance: { id: string } }>(
      await callRoute(radarrPost, {
        method: "POST",
        headers: FROM,
        body: { name: "Movies", url: "http://radarr:7878", apiKey: "RADARR-SECRET-KEY" },
      }),
      201,
    );
    const id = created.instance.id;
    await expectJson(
      await callRouteWithParams(radarrPut, { id }, { method: "PUT", headers: FROM, body: { name: "Films", apiKey: "NEW-SECRET-KEY" } }),
    );
    await expectJson(await callRouteWithParams(radarrDelete, { id }, { method: "DELETE", headers: FROM }));

    expect(audit()).toEqual([
      ['Radarr instance "Movies" added', { address: ADDRESS }],
      ['Radarr instance "Films" updated', { address: ADDRESS, urlChanged: false, keyChanged: true, enabled: true }],
      ['Radarr instance "Films" removed', { address: ADDRESS }],
    ]);
    const everything = JSON.stringify(vi.mocked(apiLogger.info).mock.calls);
    expect(everything).not.toContain("SECRET-KEY");
    expect(everything).not.toContain("radarr:7878");
  });

  it("an integration edit that changes nothing about the connection says so", async () => {
    const instance = await createTestRadarrInstance(userId, { name: "Movies" });
    await expectJson(
      await callRouteWithParams(radarrPut, { id: instance.id }, { method: "PUT", headers: FROM, body: { enabled: false } }),
    );
    expect(audit()).toEqual([
      ['Radarr instance "Movies" updated', { address: ADDRESS, urlChanged: false, keyChanged: false, enabled: false }],
    ]);
  });

  it("media servers: added, and a connection change — never the token", async () => {
    const created = await expectJson<{ server: { id: string } }>(
      await callRoute(serversPost, {
        method: "POST",
        headers: FROM,
        body: { name: "Plex", url: "http://plex:32400", accessToken: "PLEX-SECRET-TOKEN", type: "PLEX" },
      }),
      201,
    );
    await expectJson(
      await callRouteWithParams(
        serverPut,
        { id: created.server.id },
        { method: "PUT", headers: FROM, body: { url: "http://plex2:32400", accessToken: "OTHER-SECRET-TOKEN" } },
      ),
    );

    expect(audit()).toEqual([
      ['Media server "Plex" (PLEX) added', { address: ADDRESS }],
      [
        'Media server "Plex" connection changed',
        { address: ADDRESS, urlChanged: true, tokenChanged: true, tlsSkipVerify: false },
      ],
    ]);
    expect(JSON.stringify(vi.mocked(apiLogger.info).mock.calls)).not.toContain("SECRET-TOKEN");
  });

  it("a media-server edit that leaves the connection alone is not an audit event", async () => {
    const server = await createTestServer(userId);
    await expectJson(
      await callRouteWithParams(serverPut, { id: server.id }, { method: "PUT", headers: FROM, body: { name: "Renamed" } }),
    );
    expect(audit()).toEqual([]);
  });

  it("backups: who downloaded and who deleted one", async () => {
    const filename = "librariarr-backup-audit-test.json.gz";
    const dir = process.env.BACKUP_DIR!;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), "x");

    const download = await callRouteWithParams(backupGet, { filename }, { headers: FROM });
    expect(download.status).toBe(200);
    await expectJson(await callRouteWithParams(backupDelete, { filename }, { method: "DELETE", headers: FROM }));

    expect(audit()).toEqual([
      [`Backup downloaded: ${filename}`, { address: ADDRESS }],
      [`Backup deleted: ${filename}`, { address: ADDRESS }],
    ]);
  });

  it("a backup that is not there is not logged as downloaded or deleted", async () => {
    const filename = "librariarr-backup-missing.json.gz";
    expect((await callRouteWithParams(backupGet, { filename }, { headers: FROM })).status).toBe(404);
    expect((await callRouteWithParams(backupDelete, { filename }, { method: "DELETE", headers: FROM })).status).toBe(404);
    expect(audit()).toEqual([]);
  });

  it("signing out", async () => {
    await expectJson(
      await callRoute(logoutPost, {
        method: "POST",
        headers: { ...FROM, origin: "http://localhost:3000", host: "localhost:3000" },
      }),
    );
    expect(apiLogger.info).toHaveBeenCalledWith("Auth", "Signed out — every session revoked", { address: ADDRESS });
  });
});
