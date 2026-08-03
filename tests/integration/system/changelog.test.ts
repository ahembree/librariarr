import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

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

// Import route handler AFTER mocks
import { GET } from "@/app/api/system/changelog/route";
import { appCache } from "@/lib/cache/memory-cache";
import { __resetVersionCacheState } from "@/lib/version/update-checker";

interface ChangelogBody {
  notes: { version: string; isLatest: boolean; isCurrent: boolean }[];
  ok: boolean;
  stale: boolean;
  error: string | null;
  fetchedAt: string;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const ORIGINAL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION;

describe("GET /api/system/changelog", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    appCache.clear();
    __resetVersionCacheState();
    vi.stubGlobal("fetch", vi.fn());
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    appCache.clear();
    __resetVersionCacheState();
    if (ORIGINAL_VERSION === undefined) {
      delete process.env.NEXT_PUBLIC_APP_VERSION;
    } else {
      process.env.NEXT_PUBLIC_APP_VERSION = ORIGINAL_VERSION;
    }
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/system/changelog" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns release notes flagged against the running version", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([
        { tag_name: "v1.2.0", name: "1.2.0", body: "* current", html_url: "u2" },
        { tag_name: "v1.3.0", name: "1.3.0", body: "* newer", html_url: "u3" },
      ]),
    );

    const response = await callRoute(GET, { url: "/api/system/changelog" });
    const body = await expectJson<ChangelogBody>(response, 200);

    expect(body.ok).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.error).toBeNull();
    expect(body.notes.map((n) => n.version)).toEqual(["1.3.0", "1.2.0"]);
    expect(body.notes[0].isLatest).toBe(true);
    expect(body.notes[1].isCurrent).toBe(true);
  });

  it("reports ok with an empty list when no releases are published", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));

    const response = await callRoute(GET, { url: "/api/system/changelog" });
    const body = await expectJson<ChangelogBody>(response, 200);

    // The client renders "no releases yet" for this, not an error state.
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.notes).toEqual([]);
  });

  it("returns 200 with ok=false and a reason when GitHub is unreachable", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));

    const response = await callRoute(GET, { url: "/api/system/changelog" });
    const body = await expectJson<ChangelogBody>(response, 200);

    expect(body.ok).toBe(false);
    expect(body.notes).toEqual([]);
    expect(body.error).toContain("network down");
  });

  it("does not pin a failure — a retry after the short TTL succeeds", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    vi.mocked(fetch).mockRejectedValueOnce(new Error("transient"));
    const failed = await expectJson<ChangelogBody>(
      await callRoute(GET, { url: "/api/system/changelog" }),
      200,
    );
    expect(failed.ok).toBe(false);

    // Simulate the 1-minute failure TTL elapsing, then a healthy GitHub.
    appCache.invalidate("version:changelog");
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([{ tag_name: "v1.3.0", name: "1.3.0", body: "b", html_url: "u" }]),
    );

    const retried = await expectJson<ChangelogBody>(
      await callRoute(GET, { url: "/api/system/changelog" }),
      200,
    );
    expect(retried.ok).toBe(true);
    expect(retried.notes.map((n) => n.version)).toEqual(["1.3.0"]);
  });

  it("serves the last good notes as stale when a refresh fails", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([{ tag_name: "v1.3.0", name: "1.3.0", body: "b", html_url: "u" }]),
    );
    const fresh = await expectJson<ChangelogBody>(
      await callRoute(GET, { url: "/api/system/changelog" }),
      200,
    );
    expect(fresh.stale).toBe(false);

    appCache.invalidate("version:changelog");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("github down"));

    const stale = await expectJson<ChangelogBody>(
      await callRoute(GET, { url: "/api/system/changelog" }),
      200,
    );
    expect(stale.ok).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.notes.map((n) => n.version)).toEqual(["1.3.0"]);
  });
});
