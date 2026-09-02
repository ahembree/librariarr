import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  expectJson,
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
} from "../../setup/test-helpers";
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

import { GET } from "@/app/api/v1/lifecycle/rules/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Envelope {
  items: any[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function authed(scope: "READ_ONLY" | "READ_WRITE" = "READ_ONLY") {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id, { scope });
  return { user, raw };
}

function list(key: string, searchParams?: Record<string, string>) {
  return callV1(GET, { url: "/api/v1/lifecycle/rules", key, searchParams });
}

/** `createdAt` defaults to a client-side `new Date()`, so pin it for ordering. */
async function pinCreatedAt(id: string, createdAt: Date) {
  await getTestPrisma().ruleSet.update({ where: { id }, data: { createdAt } });
}

describe("GET /api/v1/lifecycle/rules", () => {
  it("returns an empty envelope when nothing exists", async () => {
    const { raw } = await authed();
    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("returns the rule set shape with a live match count", async () => {
    const { user, raw } = await authed();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    const a = await createTestMediaItem(library.id, { title: "A" });
    const b = await createTestMediaItem(library.id, { title: "B" });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Old movies",
      type: "MOVIE",
      actionType: "DELETE_RADARR",
      actionEnabled: true,
      actionDelayDays: 14,
    });
    await createTestRuleMatch(ruleSet.id, a.id);
    await createTestRuleMatch(ruleSet.id, b.id);

    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item).toMatchObject({
      id: ruleSet.id,
      name: "Old movies",
      enabled: true,
      libraryType: "MOVIE",
      actionType: "DELETE_RADARR",
      actionEnabled: true,
      actionDelayDays: 14,
      matchCount: 2,
    });
    expect(typeof item.createdAt).toBe("string");
    expect(typeof item.updatedAt).toBe("string");
    // The predicate tree and the raw `type` column are deliberately off the wire.
    expect(item).not.toHaveProperty("rules");
    expect(item).not.toHaveProperty("type");
  });

  it("reports zero matches for a rule set nothing matched", async () => {
    const { user, raw } = await authed();
    await createTestRuleSet(user.id, { name: "Nothing" });
    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items[0].matchCount).toBe(0);
  });

  it("orders newest first and paginates with a stable tiebreaker", async () => {
    const { user, raw } = await authed();
    const oldest = await createTestRuleSet(user.id, { name: "oldest" });
    const middle = await createTestRuleSet(user.id, { name: "middle" });
    const newest = await createTestRuleSet(user.id, { name: "newest" });
    // Two rows share a timestamp on purpose: `{ id: "asc" }` is what stops the
    // page boundary from permuting them between the two requests below.
    await pinCreatedAt(oldest.id, new Date("2024-01-01T00:00:00Z"));
    await pinCreatedAt(middle.id, new Date("2024-06-01T00:00:00Z"));
    await pinCreatedAt(newest.id, new Date("2024-06-01T00:00:00Z"));

    const first = await expectJson<Envelope>(await list(raw, { limit: "2" }));
    expect(first.pagination).toEqual({ page: 1, limit: 2, hasMore: true });
    expect(first.items).toHaveLength(2);

    const second = await expectJson<Envelope>(await list(raw, { limit: "2", page: "2" }));
    expect(second.pagination).toEqual({ page: 2, limit: 2, hasMore: false });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).toBe(oldest.id);

    const stitched = [...first.items, ...second.items].map((r) => r.id);
    expect(new Set(stitched).size).toBe(3);
    expect(stitched).toContain(middle.id);
    expect(stitched).toContain(newest.id);
  });

  it("clamps limit to 200 and floors page and limit at 1", async () => {
    const { raw } = await authed();
    const clamped = await expectJson<Envelope>(await list(raw, { limit: "1000" }));
    expect(clamped.pagination.limit).toBe(200);

    const floored = await expectJson<Envelope>(await list(raw, { limit: "0" }));
    expect(floored.pagination.limit).toBe(1);

    const garbage = await expectJson<Envelope>(await list(raw, { limit: "abc" }));
    expect(garbage.pagination.limit).toBe(50);

    const zeroPage = await expectJson<Envelope>(await list(raw, { page: "0" }));
    expect(zeroPage.pagination.page).toBe(1);
  });

  it("never returns another user's rule sets", async () => {
    const { raw } = await authed();
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    await createTestRuleSet(stranger.id, { name: "Not yours" });

    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items).toEqual([]);
  });
});
