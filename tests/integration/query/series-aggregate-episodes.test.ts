/**
 * Series-aggregate fields in the EPISODE view (`includeEpisodes: true`).
 *
 * Regression: the ungrouped per-episode path cannot evaluate a series-aggregate
 * field (it reads NULL off an individual episode), so a query like
 * `watchedEpisodePercentage < 50` with `includeEpisodes` used to return ZERO
 * episodes (preview) and break the /api/query/actions member re-resolution
 * (delete mis-target). The engine must instead resolve which SERIES survive via
 * aggregation and return their member episodes individually.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
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

// Import AFTER mocks
import { executeQuery } from "@/lib/query/query-engine";

interface MatchableItem {
  id: string;
  type?: string;
  parentTitle?: string | null;
}

describe("executeQuery — series-aggregate fields with includeEpisodes", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /**
   * Seeds two shows:
   *  - "Watched Show": 4 episodes, 2 watched → watchedEpisodePercentage = 50
   *  - "Stale Show":   4 episodes, 0 watched → watchedEpisodePercentage = 0
   * Rule `watchedEpisodePercentage < 50` matches ONLY "Stale Show".
   */
  async function seedTwoShows(libraryId: string) {
    const stale: string[] = [];
    for (let e = 1; e <= 4; e++) {
      const ep = await createTestMediaItem(libraryId, {
        type: "SERIES", title: `Stale S1E${e}`, parentTitle: "Stale Show",
        seasonNumber: 1, episodeNumber: e, playCount: 0,
      });
      stale.push(ep.id);
    }
    for (let e = 1; e <= 4; e++) {
      await createTestMediaItem(libraryId, {
        type: "SERIES", title: `Watched S1E${e}`, parentTitle: "Watched Show",
        seasonNumber: 1, episodeNumber: e, playCount: e <= 2 ? 3 : 0,
      });
    }
    return { staleEpisodeIds: stale };
  }

  function aggregateQuery(serverId: string, includeEpisodes: boolean): QueryDefinition {
    return {
      mediaTypes: ["SERIES"],
      serverIds: [serverId],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "watchedEpisodePercentage", operator: "lessThan", value: 50, condition: "AND" },
          ],
          groups: [],
        },
      ],
      sortBy: "title",
      sortOrder: "asc",
      includeEpisodes,
    };
  }

  it("returns the member episodes of the surviving series (episode view)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const { staleEpisodeIds } = await seedTwoShows(library.id);

    const result = await executeQuery(aggregateQuery(server.id, true), user.id, 1, 0);
    const items = result.items as unknown as MatchableItem[];

    // Exactly the 4 episodes of the stale show — individual episodes, not grouped.
    expect(new Set(items.map((i) => i.id))).toEqual(new Set(staleEpisodeIds));
    expect(items.every((i) => i.type === "SERIES" && i.parentTitle === "Stale Show")).toBe(true);
  });

  it("returns one grouped row for the surviving series (grouped view)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await seedTwoShows(library.id);

    const result = await executeQuery(aggregateQuery(server.id, false), user.id, 1, 0);
    const items = result.items as unknown as MatchableItem[];

    // Grouped: a single show row (parentTitle nulled, title = show name).
    expect(items).toHaveLength(1);
    expect((items[0] as { title?: string }).title).toBe("Stale Show");
  });
});
