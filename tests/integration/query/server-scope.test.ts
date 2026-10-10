/**
 * The Query page's server picker: `serverIds` empty = every enabled server,
 * one id = that server only, several ids = exactly those servers.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import type { QueryDefinition } from "@/lib/query/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { executeQuery } from "@/lib/query/query-engine";
import { appCache } from "@/lib/cache/memory-cache";

function query(serverIds: string[]): QueryDefinition {
  return { mediaTypes: ["MOVIE"], serverIds, groups: [], sortBy: "title", sortOrder: "asc" };
}

describe("executeQuery — server selection", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seed() {
    const user = await createTestUser();
    const ids: Record<string, string> = {};
    for (const name of ["A", "B", "C"]) {
      const server = await createTestServer(user.id, { name: `Server ${name}`, machineId: `m-${name}` });
      const lib = await createTestLibrary(server.id, { type: "MOVIE", key: `lib-${name}` });
      await createTestMediaItem(lib.id, { type: "MOVIE", title: `Movie ${name}`, ratingKey: `rk-${name}` });
      ids[name] = server.id;
    }
    const disabled = await createTestServer(user.id, { name: "Server D", machineId: "m-D", enabled: false });
    const dLib = await createTestLibrary(disabled.id, { type: "MOVIE", key: "lib-D" });
    await createTestMediaItem(dLib.id, { type: "MOVIE", title: "Movie D", ratingKey: "rk-D" });
    ids.D = disabled.id;
    return { userId: user.id, ids };
  }

  const titles = (r: Awaited<ReturnType<typeof executeQuery>>) =>
    r.items.map((i) => (i as { title: string }).title).sort();

  it("queries every enabled server when none is selected", async () => {
    const { userId } = await seed();
    expect(titles(await executeQuery(query([]), userId, 1, 0))).toEqual(["Movie A", "Movie B", "Movie C"]);
  });

  it("queries only the one selected server", async () => {
    const { userId, ids } = await seed();
    expect(titles(await executeQuery(query([ids.B]), userId, 1, 0))).toEqual(["Movie B"]);
  });

  it("queries exactly the selected servers", async () => {
    const { userId, ids } = await seed();
    expect(titles(await executeQuery(query([ids.A, ids.C]), userId, 1, 0))).toEqual(["Movie A", "Movie C"]);
  });

  it("never queries a disabled server, even when selected", async () => {
    const { userId, ids } = await seed();
    expect(titles(await executeQuery(query([ids.D]), userId, 1, 0))).toEqual([]);
    expect(titles(await executeQuery(query([ids.A, ids.D]), userId, 1, 0))).toEqual(["Movie A"]);
  });
});
