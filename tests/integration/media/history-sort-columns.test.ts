import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
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
vi.mock("@/lib/cache/memory-cache", () => {
  const noopCache = {
    get: () => undefined,
    set: () => {},
    getOrSet: async (_k: string, compute: () => Promise<unknown>) => compute(),
    invalidate: () => {},
    invalidatePrefix: () => {},
    clear: () => {},
  };
  return { MemoryCache: vi.fn(() => noopCache), appCache: noopCache };
});

import { GET } from "@/app/api/media/history/route";

type Row = {
  serverUsername: string;
  mediaItem: { title: string; dynamicRange: string | null; videoCodec: string | null };
  server: { name: string };
};

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/** The `key: "value"` pairs of a `const NAME: Record<string, string> = { … }` literal. */
function recordLiteral(source: string, name: string): Record<string, string> {
  const start = source.indexOf(`const ${name}`);
  const body = source.slice(start, source.indexOf("};", start));
  const pairs: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*(\w+):\s*["']([^"']+)["']/gm)) pairs[match[1]] = match[2];
  return pairs;
}

describe("Watch History page sort columns vs /api/media/history", () => {
  // The page maps each sortable column to a `sortBy`. A value the route does
  // not know silently sorts by watch date while the header shows the clicked
  // column's arrow, and two columns sharing a value make the page's reverse map
  // put the arrow on the wrong one — both shipped (HDR, codecs, Server).
  it("maps every column to its own sort key the route honours", () => {
    const page = recordLiteral(read("src/app/(authenticated)/library/history/page.tsx"), "COLUMN_TO_SORT_FIELD");
    const route = read("src/app/api/media/history/route.ts");
    const sortMap = route.slice(route.indexOf("const SORT_MAP"), route.indexOf("};", route.indexOf("const SORT_MAP")));
    const routeKeys = new Set([...sortMap.matchAll(/^\s*(\w+):\s*'/gm)].map((m) => m[1]));

    const values = Object.values(page);
    expect(values.length).toBeGreaterThan(10);
    expect(new Set(values).size).toBe(values.length);
    for (const [column, key] of Object.entries(page)) {
      expect(routeKeys.has(key), `${column} → sortBy=${key}`).toBe(true);
    }
  });

  describe("sorting", () => {
    let serverA: { id: string };
    let serverB: { id: string };

    beforeEach(async () => {
      await cleanDatabase();
      clearMockSession();
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      // Server names and usernames sort in opposite orders, so a Server sort
      // that read the username column would come back reversed.
      serverA = await createTestServer(user.id, { name: "Alpha" });
      serverB = await createTestServer(user.id, { name: "Bravo", machineId: "machine-b" });
      const libA = await createTestLibrary(serverA.id, { type: "MOVIE" });
      const libB = await createTestLibrary(serverB.id, { type: "MOVIE", key: "lib-b" });
      const prisma = getTestPrisma();

      // Watch-date order (oldest first): SDR/h264/Alpha, HDR10/hevc/Bravo, Dolby Vision/av1/Alpha.
      const plays = [
        { lib: libA, server: serverA, dr: "SDR", codec: "h264", user: "zed", day: 1 },
        { lib: libB, server: serverB, dr: "HDR10", codec: "hevc", user: "amy", day: 2 },
        { lib: libA, server: serverA, dr: "Dolby Vision", codec: "av1", user: "zoe", day: 3 },
      ];
      for (const p of plays) {
        const item = await createTestMediaItem(p.lib.id, {
          title: `Film ${p.dr}`,
          dynamicRange: p.dr,
          videoCodec: p.codec,
        });
        await prisma.watchHistory.create({
          data: {
            mediaItemId: item.id,
            mediaServerId: p.server.id,
            serverUsername: p.user,
            watchedAt: new Date(Date.UTC(2024, 0, p.day)),
          },
        });
      }
    });

    afterAll(async () => {
      await disconnectTestDb();
    });

    const fetchSorted = async (sortBy: string, sortOrder: "asc" | "desc") => {
      const res = await callRoute(GET, {
        url: `/api/media/history?page=1&limit=50&sortBy=${sortBy}&sortOrder=${sortOrder}`,
      });
      return (await expectJson<{ items: Row[] }>(res, 200)).items;
    };

    it("sorts the HDR column by dynamic range, not by watch date", async () => {
      const items = await fetchSorted("dynamicRange", "asc");
      expect(items.map((r) => r.mediaItem.dynamicRange)).toEqual(["Dolby Vision", "HDR10", "SDR"]);
    });

    it("sorts the video codec column by codec", async () => {
      const items = await fetchSorted("videoCodec", "asc");
      expect(items.map((r) => r.mediaItem.videoCodec)).toEqual(["av1", "h264", "hevc"]);
    });

    it("sorts the Server column by server name, not by user", async () => {
      const desc = await fetchSorted("serverName", "desc");
      expect(desc[0].server.name).toBe("Bravo");
      expect(desc.slice(1).map((r) => r.server.name)).toEqual(["Alpha", "Alpha"]);
    });
  });
});
