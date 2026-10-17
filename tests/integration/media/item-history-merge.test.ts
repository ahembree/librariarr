import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

type Entry = { username: string; watchedAt: string | null };

const { historyByUrl, apiLoggerWarn } = vi.hoisted(() => ({
  historyByUrl: new Map<string, Entry[] | Error>(),
  apiLoggerWarn: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: apiLoggerWarn, error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn((_type: string, url: string) => ({
    getWatchHistory: vi.fn(async () => {
      const value = historyByUrl.get(url) ?? [];
      if (value instanceof Error) throw value;
      return value;
    }),
  })),
}));

import { GET } from "@/app/api/media/[id]/history/route";

type Body = {
  history: { username: string; playCount: number; lastPlayedAt: string | null }[];
  serverHistories: { serverName: string; users: { username: string; playCount: number; lastPlayedAt: string | null }[] }[];
};

describe("GET /api/media/[id]/history — per-user aggregation across copies", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    historyByUrl.clear();
    apiLoggerWarn.mockReset();
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function copyOn(name: string, dedupKey: string | null, opts: { enabled?: boolean; owner?: string } = {}) {
    const url = `http://${name.toLowerCase()}:32400`;
    const server = await createTestServer(opts.owner ?? userId, { name, url, enabled: opts.enabled ?? true });
    const lib = await createTestLibrary(server.id);
    const item = await createTestMediaItem(lib.id, { title: "Film" });
    if (dedupKey) await getTestPrisma().mediaItem.update({ where: { id: item.id }, data: { dedupKey } });
    return { url, item };
  }

  it("refuses another user's item with 403", async () => {
    const stranger = await createTestUser({ username: "stranger" });
    const { item } = await copyOn("Theirs", null, { owner: stranger.id });
    historyByUrl.set("http://theirs:32400", [{ username: "stranger", watchedAt: "2024-01-01T00:00:00.000Z" }]);
    const res = await callRouteWithParams(GET, { id: item.id });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("counts each user's plays per server and keeps the latest date", async () => {
    const a = await copyOn("Alpha", null);
    historyByUrl.set(a.url, [
      { username: "amy", watchedAt: "2024-01-01T00:00:00.000Z" },
      { username: "amy", watchedAt: "2024-03-01T00:00:00.000Z" },
      { username: "amy", watchedAt: "2024-02-01T00:00:00.000Z" },
      { username: "amy", watchedAt: null },
      { username: "bob", watchedAt: null },
      { username: "bob", watchedAt: "2023-05-05T00:00:00.000Z" },
    ]);
    const body = await expectJson<Body>(await callRouteWithParams(GET, { id: a.item.id }));
    expect(body.serverHistories).toHaveLength(1);
    expect(body.serverHistories[0].users).toEqual([
      { username: "amy", playCount: 4, lastPlayedAt: "2024-03-01T00:00:00.000Z" },
      { username: "bob", playCount: 2, lastPlayedAt: "2023-05-05T00:00:00.000Z" },
    ]);
    expect(body.history).toEqual(body.serverHistories[0].users);
  });

  it("merges every enabled copy, skipping a server that fails and a disabled one", async () => {
    const a = await copyOn("Alpha", "film-key");
    const b = await copyOn("Bravo", "film-key");
    const c = await copyOn("Charlie", "film-key");
    const d = await copyOn("Disabled", "film-key", { enabled: false });
    historyByUrl.set(a.url, [
      { username: "amy", watchedAt: "2024-01-01T00:00:00.000Z" },
      { username: "cat", watchedAt: null },
    ]);
    historyByUrl.set(b.url, [
      { username: "amy", watchedAt: "2024-06-01T00:00:00.000Z" },
      { username: "amy", watchedAt: "2024-05-01T00:00:00.000Z" },
      { username: "cat", watchedAt: "2022-01-01T00:00:00.000Z" },
      { username: "dan", watchedAt: null },
    ]);
    historyByUrl.set(c.url, new Error("server down"));
    historyByUrl.set(d.url, [{ username: "ghost", watchedAt: "2025-01-01T00:00:00.000Z" }]);

    const body = await expectJson<Body>(await callRouteWithParams(GET, { id: a.item.id }));
    expect(body.serverHistories.map((s) => s.serverName).sort()).toEqual(["Alpha", "Bravo"]);
    expect(body.history).toEqual([
      { username: "amy", playCount: 3, lastPlayedAt: "2024-06-01T00:00:00.000Z" },
      { username: "cat", playCount: 2, lastPlayedAt: "2022-01-01T00:00:00.000Z" },
      { username: "dan", playCount: 1, lastPlayedAt: null },
    ]);
    expect(apiLoggerWarn).toHaveBeenCalledWith(
      "Media",
      expect.stringContaining("Charlie"),
      expect.objectContaining({ error: expect.stringContaining("server down") }),
    );
  });

  it("keeps an earlier merged date when a later server's play is older", async () => {
    const a = await copyOn("Alpha", "k2");
    const b = await copyOn("Bravo", "k2");
    historyByUrl.set(a.url, [{ username: "amy", watchedAt: "2024-09-01T00:00:00.000Z" }]);
    historyByUrl.set(b.url, [{ username: "amy", watchedAt: "2020-01-01T00:00:00.000Z" }]);
    const body = await expectJson<Body>(await callRouteWithParams(GET, { id: b.item.id }));
    expect(body.history).toEqual([{ username: "amy", playCount: 2, lastPlayedAt: "2024-09-01T00:00:00.000Z" }]);
  });
});
