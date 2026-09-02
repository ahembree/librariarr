import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import { createTestUser, createTestApiKey, expectJson } from "../../setup/test-helpers";
import { callV1 } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/v1/me/route";
import { resetApiKeyTouchState } from "@/lib/auth/api-key";

interface MeBody {
  key: {
    id: string;
    name: string;
    prefix: string;
    scope: string;
    status: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  };
}

const URL_ME = "/api/v1/me";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  resetApiKeyTouchState();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

/**
 * `lastUsedAt` is written fire-and-forget after the response is returned, so a
 * plain re-read races the update. Poll briefly instead; if the write never
 * lands the assertion still fails rather than passing vacuously.
 */
async function waitForLastUsed(id: string, timeoutMs = 3000): Promise<Date | null> {
  const prisma = getTestPrisma();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.apiKey.findUnique({ where: { id } });
    if (row?.lastUsedAt) return row.lastUsedAt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describe("GET /api/v1/me", () => {
  it("reports the calling key's own metadata", async () => {
    const user = await createTestUser();
    const { apiKey, raw } = await createTestApiKey(user.id, {
      name: "Home Assistant",
      scope: "READ_ONLY",
    });

    const body = await expectJson<MeBody>(await callV1(GET, { url: URL_ME, key: raw }));
    expect(body.key).toEqual({
      id: apiKey.id,
      name: "Home Assistant",
      prefix: apiKey.prefix,
      scope: "READ_ONLY",
      status: "active",
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: apiKey.createdAt.toISOString(),
    });
  });

  it("never returns the stored digest or the raw secret", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const text = await (await callV1(GET, { url: URL_ME, key: raw })).text();
    expect(text).not.toContain("keyHash");
    expect(text).not.toContain(raw);
  });

  it("reports READ_WRITE scope for a write-capable key", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id, { scope: "READ_WRITE" });

    const body = await expectJson<MeBody>(await callV1(GET, { url: URL_ME, key: raw }));
    expect(body.key.scope).toBe("READ_WRITE");
    expect(body.key.status).toBe("active");
  });

  it("surfaces a future expiry as an ISO timestamp on an active key", async () => {
    const user = await createTestUser();
    const expiresAt = new Date(Date.now() + 86_400_000);
    const { raw } = await createTestApiKey(user.id, { expiresAt });

    const body = await expectJson<MeBody>(await callV1(GET, { url: URL_ME, key: raw }));
    expect(body.key.expiresAt).toBe(expiresAt.toISOString());
    expect(body.key.status).toBe("active");
  });

  it("returns the pre-request lastUsedAt, not the touch this call triggers", async () => {
    const user = await createTestUser();
    const previous = new Date(Date.now() - 7 * 86_400_000);
    const { raw } = await createTestApiKey(user.id, { lastUsedAt: previous });

    const body = await expectJson<MeBody>(await callV1(GET, { url: URL_ME, key: raw }));
    expect(body.key.lastUsedAt).toBe(previous.toISOString());
  });

  it("stamps lastUsedAt on a successful call", async () => {
    const user = await createTestUser();
    const { apiKey, raw } = await createTestApiKey(user.id);
    expect(apiKey.lastUsedAt).toBeNull();

    const before = Date.now();
    expect((await callV1(GET, { url: URL_ME, key: raw })).status).toBe(200);

    const stamped = await waitForLastUsed(apiKey.id);
    expect(stamped).not.toBeNull();
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("does not stamp lastUsedAt when the key is rejected", async () => {
    const user = await createTestUser();
    const { apiKey, raw } = await createTestApiKey(user.id, {
      revokedAt: new Date(Date.now() - 1000),
    });

    expect((await callV1(GET, { url: URL_ME, key: raw })).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const row = await getTestPrisma().apiKey.findUnique({ where: { id: apiKey.id } });
    expect(row?.lastUsedAt).toBeNull();
  });

  it("identifies the key that was presented, not some other user's key", async () => {
    const owner = await createTestUser({ plexId: "owner", username: "owner" });
    const other = await createTestUser({ plexId: "other", username: "other" });
    const mine = await createTestApiKey(owner.id, { name: "mine" });
    await createTestApiKey(other.id, { name: "theirs" });

    const body = await expectJson<MeBody>(
      await callV1(GET, { url: URL_ME, key: mine.raw }),
    );
    expect(body.key.id).toBe(mine.apiKey.id);
    expect(body.key.name).toBe("mine");
  });
});
