import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handlers AFTER mocks
import { GET, PUT } from "@/app/api/tools/transcode-manager/route";

const DEFAULT_CRITERIA = {
  anyTranscoding: false,
  videoTranscoding: false,
  audioTranscoding: false,
  fourKTranscoding: false,
  remoteTranscoding: false,
};

describe("Tools transcode manager endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/tools/transcode-manager -----

  describe("GET /api/tools/transcode-manager", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/tools/transcode-manager" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns defaults when no settings exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/tools/transcode-manager" });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
        criteria: Record<string, boolean>;
      }>(response, 200);

      expect(body.enabled).toBe(false);
      expect(body.message).toBe("");
      expect(body.delay).toBe(30);
      expect(body.criteria).toEqual(DEFAULT_CRITERIA);
    });

    it("returns saved settings", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const customCriteria = {
        anyTranscoding: false,
        videoTranscoding: true,
        audioTranscoding: false,
        fourKTranscoding: true,
        remoteTranscoding: false,
      };

      // Save settings first
      await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: {
          enabled: true,
          message: "Transcoding not allowed",
          delay: 15,
          criteria: customCriteria,
        },
      });

      const response = await callRoute(GET, { url: "/api/tools/transcode-manager" });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
        criteria: Record<string, boolean>;
      }>(response, 200);

      expect(body.enabled).toBe(true);
      expect(body.message).toBe("Transcoding not allowed");
      expect(body.delay).toBe(15);
      expect(body.criteria).toEqual(customCriteria);
    });
  });

  // ----- PUT /api/tools/transcode-manager -----

  describe("PUT /api/tools/transcode-manager", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: true, message: "Test" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("creates settings when none exist (upsert create)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: true, message: "No transcoding" },
      });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
        criteria: Record<string, boolean>;
      }>(response, 200);

      expect(body.enabled).toBe(true);
      expect(body.message).toBe("No transcoding");
      expect(body.delay).toBe(30);
      expect(body.criteria).toEqual(DEFAULT_CRITERIA);
    });

    it("updates existing settings (upsert update)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Create initial settings
      await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: true, message: "Initial", delay: 30 },
      });

      // Update settings
      const response = await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: false, message: "Updated", delay: 60 },
      });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
      }>(response, 200);

      expect(body.enabled).toBe(false);
      expect(body.message).toBe("Updated");
      expect(body.delay).toBe(60);
    });

    it("updates criteria independently", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Create initial
      await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: true, message: "Test", criteria: DEFAULT_CRITERIA },
      });

      // Update with new criteria
      const newCriteria = {
        anyTranscoding: true,
        videoTranscoding: false,
        audioTranscoding: false,
        fourKTranscoding: false,
        remoteTranscoding: false,
      };

      const response = await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: true, message: "Test", criteria: newCriteria },
      });
      const body = await expectJson<{
        criteria: Record<string, boolean>;
      }>(response, 200);

      expect(body.criteria).toEqual(newCriteria);
    });

    it("preserves delay and criteria when not provided in update", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const customCriteria = {
        anyTranscoding: false,
        videoTranscoding: true,
        audioTranscoding: true,
        fourKTranscoding: false,
        remoteTranscoding: false,
      };

      // Create with specific delay and criteria
      await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: true, message: "Initial", delay: 120, criteria: customCriteria },
      });

      // Update without delay or criteria
      const response = await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: false, message: "Updated" },
      });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
        criteria: Record<string, boolean>;
      }>(response, 200);

      expect(body.enabled).toBe(false);
      expect(body.message).toBe("Updated");
      // delay should remain at 120
      expect(body.delay).toBe(120);
      // criteria should remain unchanged
      expect(body.criteria).toEqual(customCriteria);
    });

    it("sets custom delay on creation", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(PUT, {
        url: "/api/tools/transcode-manager",
        method: "PUT",
        body: { enabled: true, message: "Custom delay", delay: 5 },
      });
      const body = await expectJson<{ delay: number }>(response, 200);

      expect(body.delay).toBe(5);
    });
  });
});
