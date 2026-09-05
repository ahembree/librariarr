/**
 * E2E regression for the reported "Series Last Played" bug: a series matched a
 * `seriesLastPlayedAt notInLastDays 365` rule claiming it was last played two
 * years ago, while the History page showed an episode played two months ago.
 *
 * The two views read different sources. `WatchHistory` is populated from the
 * server's per-user, server-wide history, but `MediaItem.lastPlayedAt` — which
 * the aggregate is a MAX() over — was only ever written from the media server's
 * per-item metadata, and that metadata is scoped to the authenticated admin
 * account (Plex `viewCount`/`lastViewedAt`; Jellyfin/Emby `UserData`). A play
 * by anyone else in the household therefore reached the History page and
 * nothing else, arming destructive lifecycle rules against a series someone was
 * actively watching.
 *
 * `reconcileWatchStateFromHistory` closes the gap; this asserts the aggregate
 * agrees with the history afterwards.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { evaluateSeriesScope } = await import("@/lib/rules/lifecycle-engine");
const { reconcileWatchStateFromHistory } = await import("@/lib/sync/watch-reconcile");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * DAY);

/** "Last played more than a year ago" — the shape that mis-fired. */
const STALE_SERIES_RULE: LifecycleRuleGroup[] = [
  {
    id: "g1",
    condition: "AND",
    rules: [
      {
        id: "r1",
        field: "seriesLastPlayedAt",
        operator: "notInLastDays",
        value: "365",
        condition: "AND",
        enabled: true,
      },
    ],
    groups: [],
  },
];

async function seedSeries() {
  const prisma = getTestPrisma();
  const user = await prisma.user.create({
    data: { username: "series-last-played", passwordHash: "x" },
  });
  const server = await prisma.mediaServer.create({
    data: {
      userId: user.id,
      name: "Plex",
      type: "PLEX",
      url: "http://plex.test:32400",
      accessToken: "x",
      machineId: "series-last-played-test",
    },
  });
  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Shows", type: "SERIES" },
  });

  // Two episodes of one show. Both carry the ADMIN's own view state: last
  // watched two years ago, which is all the item sync could see.
  const episodes = await Promise.all(
    [1, 2].map((n) =>
      prisma.mediaItem.create({
        data: {
          libraryId: library.id,
          ratingKey: `ep-${n}`,
          type: "SERIES",
          title: `Episode ${n}`,
          parentTitle: "The Show",
          seasonNumber: 1,
          episodeNumber: n,
          playCount: 1,
          lastPlayedAt: daysAgo(730),
        },
      }),
    ),
  );

  return { server, library, episodes };
}

describe("Series Last Played vs. watch history", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("stops matching 'not played in the last year' once a household play is reconciled", async () => {
    const prisma = getTestPrisma();
    const { server, episodes } = await seedSeries();

    // Before: nothing but the admin's two-year-old view — the series matches.
    const before = await evaluateSeriesScope(STALE_SERIES_RULE, [server.id]);
    expect(before).toHaveLength(1);
    expect(before[0].title).toBe("The Show");

    // The History page's source: a roommate finished episode 2 sixty days ago.
    await prisma.watchHistory.create({
      data: {
        mediaItemId: episodes[1].id,
        mediaServerId: server.id,
        serverUsername: "roommate",
        watchedAt: daysAgo(60),
      },
    });

    // The history alone must not silently fix it — the aggregate reads
    // MediaItem.lastPlayedAt, so the mismatch persists until reconciliation.
    expect(await evaluateSeriesScope(STALE_SERIES_RULE, [server.id])).toHaveLength(1);

    await reconcileWatchStateFromHistory(server.id);

    const after = await evaluateSeriesScope(STALE_SERIES_RULE, [server.id]);
    expect(after).toHaveLength(0);
  });

  it("reports the aggregate as MAX over every episode's reconciled play date", async () => {
    const prisma = getTestPrisma();
    const { server, episodes } = await seedSeries();

    await prisma.watchHistory.create({
      data: {
        mediaItemId: episodes[0].id,
        mediaServerId: server.id,
        serverUsername: "roommate",
        watchedAt: daysAgo(400),
      },
    });
    await reconcileWatchStateFromHistory(server.id);

    // 400 days is still outside the window, so the rule keeps matching — and
    // the aggregate now reports the newest play across the series, not the
    // representative episode's own date.
    const matches = await evaluateSeriesScope(STALE_SERIES_RULE, [server.id]);
    expect(matches).toHaveLength(1);
    expect(new Date(matches[0].seriesLastPlayedAt as Date).getTime()).toBe(
      daysAgo(400).getTime(),
    );
  });
});
