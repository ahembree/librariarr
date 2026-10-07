import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { QUALITY_ORDER, normalizeResolutionLabel } from "@/lib/resolution";

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

type HistoryResponse = {
  items: Array<{ mediaItem: { title: string; type: string; resolution: string | null } }>;
  pagination: { totalCount: number };
};

/**
 * Stored file resolutions as the servers report them: the standard spellings,
 * the non-standard heights a label rounds (`1024p` is shown as 1080P), the
 * absent ones (shown as Other), and values no label recognises.
 */
const STORED: Array<string | null> = [
  "4k", "4K", "2160", "2160p", "3840",
  "1080", "1080p", "1024p", "1080i",
  "720", "720p", "872",
  "480", "576", "480p",
  "sd", "360", "240",
  null, "", "weird", "Weird",
];

/** Each item is titled after its stored resolution, so a row names it. */
const titleOf = (resolution: string | null) => `res:${resolution === null ? "<null>" : resolution === "" ? "<empty>" : resolution}`;

describe("GET /api/media/history — resolution filter", () => {
  let libraryId: string;
  let tvLibraryId: string;

  async function filtered(resolution: string, extra: Record<string, string> = {}) {
    const body = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { resolution, limit: "200", ...extra } }),
      200,
    );
    expect(body.pagination.totalCount, `resolution=${resolution}`).toBe(body.items.length);
    return body.items.map((r) => r.mediaItem.title).sort();
  }

  /** What the History page labels as `label` — the page's own labeler. */
  function shownAs(label: string): string[] {
    return STORED.filter((r) => normalizeResolutionLabel(r) === label).map(titleOf).sort();
  }

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(user.id);
    libraryId = (await createTestLibrary(server.id, { type: "MOVIE" })).id;
    tvLibraryId = (await createTestLibrary(server.id, { type: "SERIES" })).id;
    const prisma = getTestPrisma();
    let minute = 0;
    for (const resolution of STORED) {
      const item = await createTestMediaItem(libraryId, { title: titleOf(resolution) });
      // The factory defaults an omitted resolution to 1080p; write the real one.
      await prisma.mediaItem.update({ where: { id: item.id }, data: { resolution } });
      await prisma.watchHistory.create({
        data: {
          mediaItemId: item.id,
          mediaServerId: server.id,
          serverUsername: "alice",
          watchedAt: new Date(Date.UTC(2024, 5, 1, 0, minute++)),
        },
      });
    }
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("matches each label against exactly the files the page shows under it", async () => {
    for (const label of QUALITY_ORDER) {
      const expected = shownAs(label);
      expect(expected.length, `fixture has ${label} files`).toBeGreaterThan(0);
      expect(await filtered(label), label).toEqual(expected);
    }
  });

  it("matches the non-standard heights and absent values the old value list missed", async () => {
    expect(await filtered("1080P")).toContain(titleOf("1024p"));
    expect(await filtered("1080P")).toContain(titleOf("1080i"));
    expect(await filtered("720P")).toContain(titleOf("872"));
    expect(await filtered("480P")).toContain(titleOf("576"));
    expect(await filtered("SD")).toContain(titleOf("240"));
    expect(await filtered("4K")).toContain(titleOf("3840"));
    expect(await filtered("Other")).toEqual(
      [titleOf(null), titleOf(""), titleOf("weird"), titleOf("Weird")].sort(),
    );
  });

  it("reads a label in any case", async () => {
    const fourK = [titleOf("4k"), titleOf("4K"), titleOf("2160"), titleOf("2160p"), titleOf("3840")].sort();
    expect(await filtered("4K")).toEqual(fourK);
    expect(await filtered("4k")).toEqual(fourK);
    expect(await filtered("1080p")).toEqual(shownAs("1080P"));
    expect(await filtered("sd")).toEqual(shownAs("SD"));
    expect(await filtered("other")).toEqual(shownAs("Other"));
  });

  it("matches any other value against the stored resolution, ignoring case", async () => {
    // Not a label: only the files stored with that value, whatever their label.
    expect(await filtered("weird")).toEqual([titleOf("weird"), titleOf("Weird")].sort());
    expect(await filtered("WEIRD")).toEqual([titleOf("weird"), titleOf("Weird")].sort());
    expect(await filtered("2160")).toEqual([titleOf("2160")]);
    expect(await filtered("2160P")).toEqual([titleOf("2160p")]);
    expect(await filtered("1024P")).toEqual([titleOf("1024p")]);
    expect(await filtered("nothing-stored-like-this")).toEqual([]);
  });

  it("combines several values with OR, labels and stored values alike", async () => {
    expect(await filtered("1080P|weird")).toEqual(
      [...shownAs("1080P"), titleOf("weird"), titleOf("Weird")].sort(),
    );
    expect(await filtered("SD|2160")).toEqual([...shownAs("SD"), titleOf("2160")].sort());
    expect(await filtered("4K|1080P")).toEqual([...shownAs("4K"), ...shownAs("1080P")].sort());
    // A stored value inside a label it also names is listed once.
    expect(await filtered("4K|2160")).toEqual(shownAs("4K"));
    // Empty segments are ignored, as before.
    expect(await filtered("|SD||")).toEqual(shownAs("SD"));
  });

  it("still combines with the other filters by AND", async () => {
    const prisma = getTestPrisma();
    const server = await prisma.mediaServer.findFirstOrThrow();
    const episode = await createTestMediaItem(tvLibraryId, {
      type: "SERIES", title: "res:episode-1024p", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1, resolution: "1024p",
    });
    await prisma.watchHistory.create({
      data: { mediaItemId: episode.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: new Date("2024-07-01T00:00:00Z") },
    });
    expect(await filtered("1080P", { type: "SERIES" })).toEqual(["res:episode-1024p"]);
    expect(await filtered("1080P", { username: "bob" })).toEqual(["res:episode-1024p"]);
    expect(await filtered("1080P|Other", { type: "MOVIE" })).toEqual(
      [...shownAs("1080P"), ...shownAs("Other")].sort(),
    );
    expect(await filtered("720P", { type: "SERIES" })).toEqual([]);
  });
});
