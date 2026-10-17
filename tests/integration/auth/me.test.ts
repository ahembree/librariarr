import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/auth/me/route";

interface MeResponse {
  username: string;
  email: string | null;
  authMethod: string;
}

describe("GET /api/auth/me", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/auth/me", method: "GET" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns the display name and Plex method for a Plex-linked admin", async () => {
    const user = await createTestUser({ username: "ahembree", plexId: "plex-1" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/auth/me", method: "GET" });
    const body = await expectJson<MeResponse>(response, 200);
    // Exactly the display fields: never the Plex token or any other credential.
    expect(body).toEqual({ username: "ahembree", email: "test@example.com", authMethod: "Plex" });
  });

  it("labels a local-only admin as Local", async () => {
    // The factory backfills a default plexId (?? treats null as nullish), so
    // clear it explicitly to model a local-only admin.
    const user = await createTestUser({ username: "localadmin" });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "hashed", localUsername: "localadmin", plexId: null },
    });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/auth/me", method: "GET" });
    const body = await expectJson<MeResponse>(response, 200);
    expect(body.authMethod).toBe("Local");
  });

  it("prefers the SSO provider label when SSO is enabled", async () => {
    const user = await createTestUser({ username: "ssoadmin", plexId: "plex-2" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ssoEnabled: true,
        ssoProvider: "Authentik",
        ssoSubject: "8c3a3f0e-5b7d-4b8e-9f2a-1d6e4c2b7a90",
        ssoIssuer: "https://auth.example.com/application/o/librariarr/",
      },
    });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/auth/me", method: "GET" });
    const body = await expectJson<MeResponse>(response, 200);
    expect(body.authMethod).toBe("Authentik");
  });

  it("returns 401 when the user no longer exists", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    await prisma.user.delete({ where: { id: user.id } });

    const response = await callRoute(GET, { url: "/api/auth/me", method: "GET" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });
});
