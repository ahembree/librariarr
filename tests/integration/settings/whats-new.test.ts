import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockFetchChangelog } = vi.hoisted(() => ({ mockFetchChangelog: vi.fn() }));
vi.mock("@/lib/version/update-checker", () => ({ fetchChangelog: mockFetchChangelog }));

import { GET, PUT } from "@/app/api/settings/whats-new/route";

const prisma = getTestPrisma();

function note(version: string) {
  return {
    version,
    name: `v${version}`,
    body: `### Features\n\n* feature in ${version}`,
    url: `https://github.com/ahembree/librariarr/releases/tag/v${version}`,
    publishedAt: "2026-10-01T00:00:00Z",
    isCurrent: false,
    isLatest: false,
  };
}

interface WhatsNew {
  show: boolean;
  currentVersion: string | null;
  previousVersion: string | null;
  notes: { version: string }[];
}

async function signIn(lastSeenVersion: string | null) {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id, lastSeenVersion } });
  setMockSession({ userId: user.id, isLoggedIn: true });
  return user;
}

describe("/api/settings/whats-new", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.3.0");
    mockFetchChangelog.mockResolvedValue(["1.4.0", "1.3.0", "1.2.1", "1.2.0"].map(note));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("refuses an unauthenticated request", async () => {
    expect(await expectJson(await GET(), 401)).toEqual({ error: "Unauthorized" });
    await expectJson(await callRoute(PUT, { method: "PUT", body: { version: "1.3.0" } }), 401);
    expect(mockFetchChangelog).not.toHaveBeenCalled();
  });

  it("shows every release since the last one seen, up to the running one", async () => {
    await signIn("1.2.0");
    const body = await expectJson<WhatsNew>(await GET(), 200);
    expect(body.show).toBe(true);
    expect(body.currentVersion).toBe("1.3.0");
    expect(body.previousVersion).toBe("1.2.0");
    expect(body.notes.map((n) => n.version)).toEqual(["1.3.0", "1.2.1"]);
  });

  it("shows the running version's notes once on an install that never recorded one", async () => {
    await signIn(null);
    const body = await expectJson<WhatsNew>(await GET(), 200);
    expect(body.notes.map((n) => n.version)).toEqual(["1.3.0"]);
  });

  it("does not show, or ask GitHub, once the running version was seen", async () => {
    await signIn("1.3.0");
    const body = await expectJson<WhatsNew>(await GET(), 200);
    expect(body.show).toBe(false);
    expect(mockFetchChangelog).not.toHaveBeenCalled();
  });

  it("does not show in a build with no version", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "unknown");
    await signIn(null);
    expect((await expectJson<WhatsNew>(await GET(), 200)).show).toBe(false);
  });

  it("does not show an empty dialog when GitHub has no notes", async () => {
    mockFetchChangelog.mockResolvedValue([]);
    await signIn("1.2.0");
    expect((await expectJson<WhatsNew>(await GET(), 200)).show).toBe(false);
  });

  it("records the version closed, and stays closed until the next upgrade", async () => {
    const user = await signIn("1.2.0");
    const put = await callRoute(PUT, { method: "PUT", body: { version: "v1.3.0" } });
    expect(await expectJson(put, 200)).toEqual({ lastSeenVersion: "1.3.0" });
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastSeenVersion).toBe("1.3.0");
    expect((await expectJson<WhatsNew>(await GET(), 200)).show).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.4.0");
    const after = await expectJson<WhatsNew>(await GET(), 200);
    expect(after.notes.map((n) => n.version)).toEqual(["1.4.0"]);
  });

  it("never steps the recorded version back", async () => {
    const user = await signIn("1.3.0");
    const put = await callRoute(PUT, { method: "PUT", body: { version: "1.2.0" } });
    expect(await expectJson(put, 200)).toEqual({ lastSeenVersion: "1.3.0" });
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastSeenVersion).toBe("1.3.0");
  });

  it("refuses a version newer than the running one, or not a version", async () => {
    await signIn("1.2.0");
    await expectJson(await callRoute(PUT, { method: "PUT", body: { version: "1.4.0" } }), 400);
    await expectJson(await callRoute(PUT, { method: "PUT", body: { version: "latest" } }), 400);
    await expectJson(await callRoute(PUT, { method: "PUT", body: {} }), 400);
  });
});
