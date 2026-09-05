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

const emit = vi.fn();
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: (e: unknown) => emit(e) } }));

vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue(undefined),
  buildMaintenanceEmbed: vi.fn(() => ({})),
}));

import { PUT as maintenancePut } from "@/app/api/tools/maintenance/route";
import { PUT as dedupPut } from "@/app/api/settings/dedup/route";
import { DELETE as purgeDelete } from "@/app/api/media/purge/route";

function emittedTypes(): string[] {
  return emit.mock.calls.map((c) => (c[0] as { type: string }).type);
}

/**
 * These routes all mutate state that some page is rendering. Each one used to
 * return without emitting anything, so the UI stayed stale until a reload.
 *
 * The assertions are deliberately about *whether an event is emitted at all*
 * rather than about any figure it carries — the events are intentionally
 * data-free so the route that owns the numbers stays the only place they are
 * computed.
 */
describe("mutation routes emit app events", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("PUT /api/tools/maintenance", () => {
    it("emits settings:changed when maintenance actually toggles", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const res = await callRoute(maintenancePut, {
        method: "PUT",
        body: { enabled: true, message: "back soon" },
      });
      await expectJson(res, 200);

      expect(emittedTypes()).toContain("settings:changed");
      const event = emit.mock.calls
        .map((c) => c[0] as { type: string; userId: string; meta?: Record<string, unknown> })
        .find((e) => e.type === "settings:changed")!;
      expect(event.userId).toBe(user.id);
      expect(event.meta).toMatchObject({ maintenanceMode: true });
    });

    it("stays silent when the toggle did not change state", async () => {
      // The UI saves on every keystroke of the custom message while maintenance
      // is on. Emitting per PUT would put an event on the wire for each one.
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await callRoute(maintenancePut, { method: "PUT", body: { enabled: true, message: "a" } });
      emit.mockClear();
      await callRoute(maintenancePut, { method: "PUT", body: { enabled: true, message: "ab" } });

      expect(emittedTypes()).not.toContain("settings:changed");
    });
  });

  describe("PUT /api/settings/dedup", () => {
    it("emits sync:completed because the toggle changes which copy every listing renders", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const res = await callRoute(dedupPut, { method: "PUT", body: { dedupStats: false } });
      await expectJson(res, 200);

      expect(emittedTypes()).toContain("sync:completed");
    });
  });

  describe("DELETE /api/media/purge", () => {
    it("emits sync:completed so open library listings stop rendering deleted rows", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      await createTestMediaItem(library.id, { title: "Doomed" });
      setMockSession({ userId: user.id, isLoggedIn: true });

      const res = await callRoute(purgeDelete, {
        method: "DELETE",
        searchParams: { libraryId: library.id },
      });
      await expectJson(res, 200);

      expect(emittedTypes()).toContain("sync:completed");
    });
  });

  it("does not emit for an unauthenticated caller", async () => {
    clearMockSession();

    await callRoute(maintenancePut, { method: "PUT", body: { enabled: true, message: "x" } });

    expect(emit).not.toHaveBeenCalled();
  });
});
