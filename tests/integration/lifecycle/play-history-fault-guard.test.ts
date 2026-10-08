import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser, createTestServer } from "../../setup/test-helpers";
import {
  playHistoryFault,
  type PlayHistoryEvidence,
  type PlayHistoryFault,
} from "@/lib/lifecycle/play-history-fault";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as listServers } from "@/app/api/servers/route";
import { checkWatchHistoryCompleteness } from "@/lib/lifecycle/evaluability";

/**
 * The rule editor's play-history banner mirrors `checkWatchHistoryCompleteness`, pinned here to the real guard
 * over the real `/api/servers` payload: the same fault, in the same precedence, or none.
 */

/** A phrase of the guard's reason for each fault the banner reports. */
const GUARD_REASON: Record<PlayHistoryFault, RegExp> = {
  resync: /waits for a complete library sync/,
  importing: /has not finished walking back through the archive/,
  unsynced: /no sync has established what was played there/,
  gap: /a Tracearr import is reading recent plays, or one was interrupted/,
};

const AT = new Date("2026-10-01T12:00:00Z");

type State = {
  libraryResyncRequiredAt?: Date | null;
  watchHistorySyncedAt?: Date | null;
  tracearrServerId?: string | null;
  tracearrBackfillComplete?: boolean;
  tracearrForwardFloorAt?: Date | null;
};

/** Every combination that matters, with the fault the guard reports first. */
const CASES: Array<[string, State, PlayHistoryFault | null]> = [
  ["native, established", { watchHistorySyncedAt: AT }, null],
  ["native, never synced", { watchHistorySyncedAt: null }, "unsynced"],
  ["native, held for a library resync", { libraryResyncRequiredAt: AT, watchHistorySyncedAt: null }, "resync"],
  ["native, held with the marker still set", { libraryResyncRequiredAt: AT, watchHistorySyncedAt: AT }, "resync"],
  // Stale Tracearr columns on an unmapped server describe nothing.
  ["native, floor left by an unlink", { watchHistorySyncedAt: AT, tracearrForwardFloorAt: AT }, null],
  ["native, schema-default backfill flag", { watchHistorySyncedAt: AT, tracearrBackfillComplete: false }, null],
  ["mapped, complete", { watchHistorySyncedAt: AT, tracearrServerId: "T", tracearrBackfillComplete: true }, null],
  ["mapped, importing", { watchHistorySyncedAt: AT, tracearrServerId: "T", tracearrBackfillComplete: false }, "importing"],
  [
    "mapped, forward gap",
    { watchHistorySyncedAt: AT, tracearrServerId: "T", tracearrBackfillComplete: true, tracearrForwardFloorAt: AT },
    "gap",
  ],
  // An unfinished walk comes before the marker and the gap: only its completion re-establishes the marker.
  [
    "mapped, gap while importing",
    { watchHistorySyncedAt: AT, tracearrServerId: "T", tracearrBackfillComplete: false, tracearrForwardFloorAt: AT },
    "importing",
  ],
  [
    "mapped, released hold: walk restarted and marker withdrawn",
    { watchHistorySyncedAt: null, tracearrServerId: "T", tracearrBackfillComplete: false },
    "importing",
  ],
  [
    "mapped, unsynced with a gap while importing",
    { watchHistorySyncedAt: null, tracearrServerId: "T", tracearrBackfillComplete: false, tracearrForwardFloorAt: AT },
    "importing",
  ],
  [
    "mapped, unsynced after its walk finished",
    { watchHistorySyncedAt: null, tracearrServerId: "T", tracearrBackfillComplete: true },
    "unsynced",
  ],
  [
    "mapped, unsynced with a gap after its walk finished",
    { watchHistorySyncedAt: null, tracearrServerId: "T", tracearrBackfillComplete: true, tracearrForwardFloorAt: AT },
    "unsynced",
  ],
  [
    "mapped, held with everything else wrong too",
    {
      libraryResyncRequiredAt: AT,
      watchHistorySyncedAt: null,
      tracearrServerId: "T",
      tracearrBackfillComplete: false,
      tracearrForwardFloorAt: AT,
    },
    "resync",
  ],
];

describe("rule editor play-history fault vs checkWatchHistoryCompleteness", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("reports the fault the guard refuses with, and nothing where it does not refuse", async () => {
    const prisma = getTestPrisma();
    const ids = new Map<string, string>();
    for (const [i, [name, state]] of CASES.entries()) {
      const server = await createTestServer(userId, { name });
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: {
          ...state,
          // One Tracearr server per mapping, as the server PUT requires.
          tracearrServerId: state.tracearrServerId ? `${state.tracearrServerId}-${i}` : null,
        },
      });
      ids.set(name, server.id);
    }

    const { servers } = await expectJson<{ servers: Array<PlayHistoryEvidence & { id: string }> }>(
      await callRoute(listServers, { url: "/api/servers" }),
      200,
    );
    expect(servers).toHaveLength(CASES.length);

    for (const [name, , expected] of CASES) {
      const row = servers.find((s) => s.id === ids.get(name));
      expect(row, name).toBeDefined();
      // The editor derives the banner from the payload exactly as delivered.
      expect(playHistoryFault(row!), name).toBe(expected);

      const guard = await checkWatchHistoryCompleteness(userId, [ids.get(name)!]);
      expect(guard.complete, name).toBe(expected === null);
      if (!guard.complete && expected !== null) {
        expect(guard.reason, name).toMatch(GUARD_REASON[expected]);
        // ...and not another fault's remedy.
        for (const [other, phrase] of Object.entries(GUARD_REASON)) {
          if (other !== expected) expect(guard.reason, `${name} vs ${other}`).not.toMatch(phrase);
        }
      }
    }
  });

  it("agrees that a disabled server is outside the guard's scope", async () => {
    // The editor drops disabled servers before showing the banner (`serversAwaitingPlayHistory`).
    const server = await createTestServer(userId, { enabled: false, watchHistorySyncedAt: null });
    await getTestPrisma().mediaServer.update({ where: { id: server.id }, data: { libraryResyncRequiredAt: AT } });
    expect((await checkWatchHistoryCompleteness(userId, [server.id])).complete).toBe(true);
  });
});
