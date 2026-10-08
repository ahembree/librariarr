import { vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { cleanDatabase, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { type FakeTracearrArchive, TRACEARR_SERVER_ID } from "./fake-tracearr-archive";

/**
 * Shared setup for the Tracearr importer's integration tests. `vi.mock` is
 * hoisted per file, so each file still declares its mocks, through this module:
 *
 *   vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
 *   vi.mock("@/lib/tracearr/tracearr-client", async () =>
 *     (await import("./tracearr-import-kit")).clientModule(100));
 */

const prisma = getTestPrisma();

/** What every mocked `TracearrClient` answers with. */
export const tracearr = {
  getHistoryPage: vi.fn(),
  getHistoryForItem: vi.fn(),
  listServers: vi.fn(),
  getServerAccountNames: vi.fn(),
  findOldestPlayAt: vi.fn(),
};

/** The mocked client module, serving pages of `pageSize` records. */
export function clientModule(pageSize: number) {
  return {
    MAX_PAGE_SIZE: pageSize,
    // Constructor mock — must be a `function`, not an arrow (Vitest 4).
    TracearrClient: function (this: Record<string, unknown>) {
      Object.assign(this, tracearr);
    },
  };
}

export function loggerModule() {
  const methods = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return { logger: methods(), apiLogger: methods(), dbLogger: methods() };
}

/**
 * Reset every mock (reset, not cleared: an unconsumed once-implementation must
 * not leak into the next test) and answer from `archive()`: its pages, its
 * oldest play, every play of a rating key, one monitored server, and the
 * account map acct-1 → walter.
 */
export function answerFrom(archive: () => FakeTracearrArchive): void {
  vi.clearAllMocks();
  for (const fn of Object.values(tracearr)) fn.mockReset();
  tracearr.getHistoryPage.mockImplementation(async (id: string, options: object) => archive().page(id, options));
  tracearr.findOldestPlayAt.mockImplementation(async (id: string) => archive().oldest(id));
  tracearr.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
  tracearr.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
  tracearr.getHistoryForItem.mockImplementation(async (id: string, filter: { ratingKey?: string }) =>
    filter.ratingKey
      ? archive().page(id, { pageSize: 1000 }).records.filter((record) => record.rating_key === filter.ratingKey)
      : [],
  );
}

export function addTracearrInstance(userId: string) {
  return prisma.tracearrInstance.create({
    data: { userId, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
  });
}

/**
 * A clean database holding one user with a Tracearr instance and a server
 * mapped to `TRACEARR_SERVER_ID` (plus `overrides`), whose movie library holds
 * The Matrix under rating key 100.
 */
export async function seedMappedServer(overrides: Parameters<typeof createTestServer>[1] = {}) {
  await cleanDatabase();
  const user = await createTestUser();
  const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_ID, ...overrides });
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  const item = await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" });
  await addTracearrInstance(user.id);
  return { userId: user.id, serverId: server.id, libraryId: library.id, itemId: item.id };
}

/** A stored TRACEARR play, finished, by walter. */
export function storeTracearrPlay(
  mediaItemId: string,
  mediaServerId: string,
  sourceEventId: string,
  watchedAt: Date,
  data: Partial<Prisma.WatchHistoryUncheckedCreateInput> = {},
) {
  return prisma.watchHistory.create({
    data: {
      mediaItemId,
      mediaServerId,
      serverUsername: "walter",
      watchedAt,
      source: "TRACEARR",
      sourceEventId,
      watched: true,
      state: "stopped",
      ...data,
    },
  });
}

/** Every stored play's `sourceEventId`, sorted. */
export async function storedIds(): Promise<string[]> {
  const rows = await prisma.watchHistory.findMany({ select: { sourceEventId: true } });
  return rows.map((row) => row.sourceEventId ?? "").sort();
}

export function serverRow(serverId: string) {
  return prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });
}
