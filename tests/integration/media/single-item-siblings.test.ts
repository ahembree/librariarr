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

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/media/[id]/route";

type Body = {
  item: { id: string; servers: { serverId: string; serverName: string; mediaItemId: string }[] };
  playServers: { serverName: string; ratingKey: string; machineId: string | null }[];
};

describe("GET /api/media/[id] — copies on other servers", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function itemOn(serverName: string, dedupKey: string | null, opts: { enabled?: boolean; owner?: string } = {}) {
    const server = await createTestServer(opts.owner ?? userId, {
      name: serverName,
      enabled: opts.enabled ?? true,
      machineId: `m-${serverName}`,
    });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(lib.id, { title: "Heat", ratingKey: `rk-${serverName}` });
    if (dedupKey) {
      await getTestPrisma().mediaItem.update({ where: { id: item.id }, data: { dedupKey } });
    }
    return { server, lib, item };
  }

  it("lists every enabled server holding a copy, sorted by name, once per server", async () => {
    const main = await itemOn("Mike", "heat-1995");
    const alpha = await itemOn("Alpha", "heat-1995");
    await itemOn("Disabled", "heat-1995", { enabled: false });
    // A second copy on the main server's own library does not add a server.
    const dup = await createTestMediaItem(main.lib.id, { title: "Heat", ratingKey: "rk-dup" });
    await getTestPrisma().mediaItem.update({ where: { id: dup.id }, data: { dedupKey: "heat-1995" } });
    // Another server with a second copy of its own: listed once.
    const zulu = await itemOn("Zulu", "heat-1995");
    const zuluDup = await createTestMediaItem(zulu.lib.id, { title: "Heat", ratingKey: "rk-zulu-2" });
    await getTestPrisma().mediaItem.update({ where: { id: zuluDup.id }, data: { dedupKey: "heat-1995" } });
    // Another user's copy is never listed.
    const stranger = await createTestUser({ username: "stranger" });
    await itemOn("Stranger", "heat-1995", { owner: stranger.id });

    const body = await expectJson<Body>(
      await callRouteWithParams(GET, { id: main.item.id }, { url: `/api/media/${main.item.id}` }),
    );
    expect(body.playServers.map((p) => p.serverName)).toEqual(["Alpha", "Mike", "Zulu"]);
    expect(body.item.servers.map((s) => s.serverName)).toEqual(["Alpha", "Mike", "Zulu"]);
    const alphaEntry = body.item.servers.find((s) => s.serverName === "Alpha")!;
    expect(alphaEntry.mediaItemId).toBe(alpha.item.id);
    expect(alphaEntry.serverId).toBe(alpha.server.id);
    expect(body.playServers.find((p) => p.serverName === "Alpha")!.ratingKey).toBe("rk-Alpha");
    expect(body.playServers.find((p) => p.serverName === "Mike")!.machineId).toBe("m-Mike");
  });

  it("lists only its own server when no other copy exists", async () => {
    const main = await itemOn("Solo", "unique-key");
    const body = await expectJson<Body>(
      await callRouteWithParams(GET, { id: main.item.id }, { url: `/api/media/${main.item.id}` }),
    );
    expect(body.playServers.map((p) => p.serverName)).toEqual(["Solo"]);
    expect(body.item.servers).toEqual([
      expect.objectContaining({ serverName: "Solo", mediaItemId: main.item.id }),
    ]);
  });

  it("returns 404 for another user's item", async () => {
    const stranger = await createTestUser({ username: "stranger" });
    const theirs = await itemOn("Theirs", null, { owner: stranger.id });
    const res = await callRouteWithParams(GET, { id: theirs.item.id }, { url: `/api/media/${theirs.item.id}` });
    expect(res.status).toBe(404);
  });
});
