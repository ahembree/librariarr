import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
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

import { GET as moviesGET } from "@/app/api/media/movies/route";
import { GET as seriesGET } from "@/app/api/media/series/route";
import { GET as musicGET } from "@/app/api/media/music/route";

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/** The `field`s of MediaTable's columns that render a clickable sort header. */
function sortableTableFields(): string[] {
  const source = read("src/components/media-table.tsx");
  const columns = source.split(/\n\s*\{\s*\n\s*id: "/).slice(1);
  const fields: string[] = [];
  for (const column of columns) {
    const field = /field: "(\w+)"/.exec(column)?.[1];
    if (!field) continue;
    // Only up to the next column; `sortable: false` opts a column out.
    if (/sortable: false/.test(column.split(/\n\s*\},?\s*\n/)[0])) continue;
    fields.push(field);
  }
  return fields;
}

function sortColumns(route: string): Set<string> {
  const source = read(route);
  const start = source.indexOf("const SORT_COLUMNS");
  const block = source.slice(start, source.indexOf("]);", start));
  return new Set([...block.matchAll(/^\s*"(\w+)",/gm)].map((m) => m[1]));
}

describe("library table sort headers vs the flat list routes", () => {
  // The Movies, All Episodes and Tracks pages send a clicked header's field as
  // `sortBy`. A field the route does not whitelist falls back to title, so the
  // header showed a sort arrow over rows still in title order.
  it("every sortable MediaTable column is a sort column of each flat route", () => {
    const fields = sortableTableFields();
    expect(fields).toContain("dynamicRange");
    expect(fields).not.toContain("servers");
    for (const route of [
      "src/app/api/media/movies/route.ts",
      "src/app/api/media/series/route.ts",
      "src/app/api/media/music/route.ts",
    ]) {
      const allowed = sortColumns(route);
      for (const field of ["title", ...fields]) {
        expect(allowed.has(field), `${route} sortBy=${field}`).toBe(true);
      }
    }
  });

  describe("sorting", () => {
    let userId: string;

    beforeEach(async () => {
      await cleanDatabase();
      clearMockSession();
      const user = await createTestUser();
      userId = user.id;
      setMockSession({ userId, isLoggedIn: true });
    });

    afterAll(async () => {
      await disconnectTestDb();
    });

    // Title order A, B, C is the reverse of dynamic-range order, so a fallback
    // to title cannot pass.
    const seed = async (type: "MOVIE" | "SERIES" | "MUSIC") => {
      const server = await createTestServer(userId);
      const library = await createTestLibrary(server.id, { type });
      const rows = [
        { title: "A", dynamicRange: "SDR", container: "mp4" },
        { title: "B", dynamicRange: "HDR10", container: "mkv" },
        { title: "C", dynamicRange: "Dolby Vision", container: "flac" },
      ];
      for (const [i, row] of rows.entries()) {
        await createTestMediaItem(library.id, {
          type,
          ...row,
          ...(type === "SERIES" ? { parentTitle: "Show", seasonNumber: 1, episodeNumber: i + 1 } : {}),
          ...(type === "MUSIC" ? { parentTitle: "Artist", albumTitle: "Album" } : {}),
        });
      }
    };

    it("movies: sortBy=dynamicRange", async () => {
      await seed("MOVIE");
      const res = await callRoute(moviesGET, {
        url: "/api/media/movies?sortBy=dynamicRange&sortOrder=asc&page=1&limit=100",
      });
      const body = await expectJson<{ items: { dynamicRange: string }[] }>(res, 200);
      expect(body.items.map((i) => i.dynamicRange)).toEqual(["Dolby Vision", "HDR10", "SDR"]);
    });

    it("episodes: sortBy=dynamicRange", async () => {
      await seed("SERIES");
      const res = await callRoute(seriesGET, {
        url: "/api/media/series?sortBy=dynamicRange&sortOrder=asc&page=1&limit=100",
      });
      const body = await expectJson<{ items: { dynamicRange: string }[] }>(res, 200);
      expect(body.items.map((i) => i.dynamicRange)).toEqual(["Dolby Vision", "HDR10", "SDR"]);
    });

    it("tracks: sortBy=container", async () => {
      await seed("MUSIC");
      const res = await callRoute(musicGET, {
        url: "/api/media/music?sortBy=container&sortOrder=asc&page=1&limit=100",
      });
      const body = await expectJson<{ items: { container: string }[] }>(res, 200);
      expect(body.items.map((i) => i.container)).toEqual(["flac", "mkv", "mp4"]);
    });
  });
});
