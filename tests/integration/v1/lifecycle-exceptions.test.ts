import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
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
  createTestCollection,
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

const { mockRemoveItemFromCollections } = vi.hoisted(() => ({
  mockRemoveItemFromCollections: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  removeItemFromCollections: mockRemoveItemFromCollections,
}));

import { GET, POST } from "@/app/api/v1/lifecycle/exceptions/route";
import { DELETE } from "@/app/api/v1/lifecycle/exceptions/[id]/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Envelope {
  items: any[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
  mockRemoveItemFromCollections.mockResolvedValue(undefined);
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedUser(scope: "READ_ONLY" | "READ_WRITE" = "READ_WRITE") {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id, { scope });
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id);
  return { user, raw, server, library };
}

function list(key: string, searchParams?: Record<string, string>) {
  return callV1(GET, { url: "/api/v1/lifecycle/exceptions", key, searchParams });
}

function create(key: string, body: unknown) {
  return callV1(POST, {
    url: "/api/v1/lifecycle/exceptions",
    method: "POST",
    key,
    body,
  });
}

function remove(key: string, id: string) {
  return callV1(DELETE, {
    url: `/api/v1/lifecycle/exceptions/${id}`,
    method: "DELETE",
    key,
    params: { id },
  });
}

describe("GET /api/v1/lifecycle/exceptions", () => {
  it("returns an empty envelope when nothing is protected", async () => {
    const { raw } = await seedUser();
    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("returns the exception shape, newest first, and paginates", async () => {
    const { user, raw, library } = await seedUser();
    const prisma = getTestPrisma();
    const older = await createTestMediaItem(library.id, { title: "Older", year: 1999 });
    const newer = await createTestMediaItem(library.id, {
      title: "Newer",
      parentTitle: "Show",
      year: 2010,
      type: "SERIES",
    });
    const first = await prisma.lifecycleException.create({
      data: {
        userId: user.id,
        mediaItemId: older.id,
        reason: "classic",
        createdAt: new Date("2024-01-01T00:00:00Z"),
      },
    });
    const second = await prisma.lifecycleException.create({
      data: {
        userId: user.id,
        mediaItemId: newer.id,
        createdAt: new Date("2024-02-01T00:00:00Z"),
      },
    });

    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items.map((e) => e.id)).toEqual([second.id, first.id]);
    expect(body.items[1]).toMatchObject({
      id: first.id,
      reason: "classic",
      mediaItem: {
        id: older.id,
        title: "Older",
        parentTitle: null,
        year: 1999,
        type: "MOVIE",
      },
    });
    expect(body.items[0].reason).toBeNull();
    expect(typeof body.items[0].createdAt).toBe("string");

    const page1 = await expectJson<Envelope>(await list(raw, { limit: "1" }));
    expect(page1.pagination).toEqual({ page: 1, limit: 1, hasMore: true });
    const page2 = await expectJson<Envelope>(await list(raw, { limit: "1", page: "2" }));
    expect(page2.pagination.hasMore).toBe(false);
    expect(page2.items[0].id).toBe(first.id);

    const clamped = await expectJson<Envelope>(await list(raw, { limit: "400" }));
    expect(clamped.pagination.limit).toBe(200);
  });

  it("never returns another user's exceptions", async () => {
    const { raw } = await seedUser();
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const strangerServer = await createTestServer(stranger.id, { name: "Theirs" });
    const strangerLib = await createTestLibrary(strangerServer.id, { key: "theirs" });
    const strangerItem = await createTestMediaItem(strangerLib.id, { title: "Private" });
    await getTestPrisma().lifecycleException.create({
      data: { userId: stranger.id, mediaItemId: strangerItem.id },
    });

    const body = await expectJson<Envelope>(await list(raw, { limit: "200" }));
    expect(body.items).toEqual([]);
  });
});

describe("POST /api/v1/lifecycle/exceptions", () => {
  it("creates the exception and returns 201 with the item it protects", async () => {
    const { user, raw, library } = await seedUser();
    const item = await createTestMediaItem(library.id, { title: "Keep Me", year: 2001 });

    const body = await expectJson<any>(
      await create(raw, { mediaItemId: item.id, reason: "  favourite  " }),
      201,
    );
    expect(body.exception).toMatchObject({
      // The schema trims, so the stored reason has no surrounding whitespace.
      reason: "favourite",
      mediaItem: {
        id: item.id,
        title: "Keep Me",
        parentTitle: null,
        year: 2001,
        type: "MOVIE",
      },
    });
    expect(typeof body.exception.id).toBe("string");
    expect(typeof body.exception.createdAt).toBe("string");

    const row = await getTestPrisma().lifecycleException.findUnique({
      where: { userId_mediaItemId: { userId: user.id, mediaItemId: item.id } },
    });
    expect(row?.reason).toBe("favourite");
  });

  it("stores a null reason when none is given", async () => {
    const { raw, library } = await seedUser();
    const item = await createTestMediaItem(library.id);
    const body = await expectJson<any>(await create(raw, { mediaItemId: item.id }), 201);
    expect(body.exception.reason).toBeNull();
  });

  it("404s for an unknown media item", async () => {
    const { raw } = await seedUser();
    const body = await expectJson<{ error: string }>(
      await create(raw, { mediaItemId: "does-not-exist" }),
      404,
    );
    expect(body.error).toBe("Media item not found");
  });

  it("404s for another user's media item and writes nothing", async () => {
    const { raw } = await seedUser();
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const strangerServer = await createTestServer(stranger.id, { name: "Theirs" });
    const strangerLib = await createTestLibrary(strangerServer.id, { key: "theirs" });
    const strangerItem = await createTestMediaItem(strangerLib.id, { title: "Private" });

    await expectJson(await create(raw, { mediaItemId: strangerItem.id }), 404);
    expect(await getTestPrisma().lifecycleException.count()).toBe(0);
  });

  it("409s on a duplicate", async () => {
    const { raw, library } = await seedUser();
    const item = await createTestMediaItem(library.id);
    await expectJson(await create(raw, { mediaItemId: item.id }), 201);

    const body = await expectJson<{ error: string }>(
      await create(raw, { mediaItemId: item.id }),
      409,
    );
    expect(body.error).toBe("A lifecycle exception already exists for this media item");
    expect(await getTestPrisma().lifecycleException.count()).toBe(1);
  });

  it("400s on malformed JSON", async () => {
    const { raw } = await seedUser();
    // Built by hand: createTestRequest stringifies its `body`, so a broken
    // payload has to be handed to NextRequest directly.
    const request = new NextRequest(
      "http://localhost:3000/api/v1/lifecycle/exceptions",
      {
        method: "POST",
        headers: { "X-Api-Key": raw, "Content-Type": "application/json" },
        body: "{ not json",
      },
    );
    const body = await expectJson<{ error: string }>(await POST(request), 400);
    expect(body.error).toBe("Invalid JSON in request body");
  });

  it("400s with details when mediaItemId is missing", async () => {
    const { raw } = await seedUser();
    const body = await expectJson<{ error: string; details: string[] }>(
      await create(raw, { reason: "no id" }),
      400,
    );
    expect(body.error).toBe("Validation failed");
    expect(body.details.join(" ")).toContain("mediaItemId");
  });

  it("400s when the reason is longer than the schema allows", async () => {
    const { raw, library } = await seedUser();
    const item = await createTestMediaItem(library.id);
    const body = await expectJson<{ error: string }>(
      await create(raw, { mediaItemId: item.id, reason: "x".repeat(501) }),
      400,
    );
    expect(body.error).toBe("Validation failed");
    expect(await getTestPrisma().lifecycleException.count()).toBe(0);
  });

  it("403s for a READ_ONLY key and leaves the item unprotected", async () => {
    const { user, library } = await seedUser();
    const { raw } = await createTestApiKey(user.id, {
      scope: "READ_ONLY",
      name: "read-only",
    });
    const item = await createTestMediaItem(library.id);

    await expectJson(await create(raw, { mediaItemId: item.id }), 403);
    expect(await getTestPrisma().lifecycleException.count()).toBe(0);
  });

  it("drops the item's matches and pending actions, keeping finished history", async () => {
    const { user, raw, library } = await seedUser();
    const prisma = getTestPrisma();
    const item = await createTestMediaItem(library.id);
    const ruleSet = await createTestRuleSet(user.id, { name: "Movie rule" });
    await createTestRuleMatch(ruleSet.id, item.id);

    const pending = await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: item.id,
        ruleSetId: ruleSet.id,
        actionType: "DELETE_RADARR",
        status: "PENDING",
        scheduledFor: new Date("2030-01-01T00:00:00Z"),
      },
    });
    const completed = await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: item.id,
        ruleSetId: ruleSet.id,
        actionType: "UNMONITOR_RADARR",
        status: "COMPLETED",
        scheduledFor: new Date("2024-01-01T00:00:00Z"),
      },
    });

    await expectJson(await create(raw, { mediaItemId: item.id }), 201);

    expect(await prisma.ruleMatch.count({ where: { mediaItemId: item.id } })).toBe(0);
    expect(await prisma.lifecycleAction.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(
      await prisma.lifecycleAction.findUnique({ where: { id: completed.id } }),
    ).not.toBeNull();
    // No contributing rule set owns a collection, so there is nothing to pull from.
    expect(mockRemoveItemFromCollections).not.toHaveBeenCalled();
  });

  it("pulls the item out of the collections its rule sets feed", async () => {
    const { user, raw, library } = await seedUser();
    const item = await createTestMediaItem(library.id, { ratingKey: "rk-99" });
    const collection = await createTestCollection(user.id, {
      name: "Up Next",
      type: "MOVIE",
    });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Movie rule",
      type: "MOVIE",
      collectionId: collection.id,
    });
    await createTestRuleMatch(ruleSet.id, item.id);

    await expectJson(await create(raw, { mediaItemId: item.id }), 201);

    expect(mockRemoveItemFromCollections).toHaveBeenCalledWith(
      user.id,
      "MOVIE",
      "Up Next",
      "rk-99",
      null,
    );
  });

  it("still creates the exception when the collection removal fails", async () => {
    const { user, raw, library } = await seedUser();
    const item = await createTestMediaItem(library.id);
    const collection = await createTestCollection(user.id, { name: "Up Next" });
    const ruleSet = await createTestRuleSet(user.id, { collectionId: collection.id });
    await createTestRuleMatch(ruleSet.id, item.id);
    mockRemoveItemFromCollections.mockRejectedValueOnce(new Error("plex down"));

    await expectJson(await create(raw, { mediaItemId: item.id }), 201);
    expect(await getTestPrisma().lifecycleException.count()).toBe(1);
  });
});

describe("DELETE /api/v1/lifecycle/exceptions/[id]", () => {
  it("removes the exception", async () => {
    const { user, raw, library } = await seedUser();
    const item = await createTestMediaItem(library.id);
    const exception = await getTestPrisma().lifecycleException.create({
      data: { userId: user.id, mediaItemId: item.id },
    });

    const body = await expectJson<{ success: boolean; id: string }>(
      await remove(raw, exception.id),
    );
    expect(body).toEqual({ success: true, id: exception.id });
    expect(await getTestPrisma().lifecycleException.count()).toBe(0);
  });

  it("404s for an unknown id", async () => {
    const { raw } = await seedUser();
    const body = await expectJson<{ error: string }>(await remove(raw, "nope"), 404);
    expect(body.error).toBe("Exception not found");
  });

  it("404s for another user's exception and leaves it intact", async () => {
    const { raw } = await seedUser();
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const strangerServer = await createTestServer(stranger.id, { name: "Theirs" });
    const strangerLib = await createTestLibrary(strangerServer.id, { key: "theirs" });
    const strangerItem = await createTestMediaItem(strangerLib.id);
    const strangerException = await getTestPrisma().lifecycleException.create({
      data: { userId: stranger.id, mediaItemId: strangerItem.id },
    });

    await expectJson(await remove(raw, strangerException.id), 404);
    expect(
      await getTestPrisma().lifecycleException.findUnique({
        where: { id: strangerException.id },
      }),
    ).not.toBeNull();
  });

  it("403s for a READ_ONLY key and leaves the exception in place", async () => {
    const { user, library } = await seedUser();
    const { raw } = await createTestApiKey(user.id, {
      scope: "READ_ONLY",
      name: "read-only",
    });
    const item = await createTestMediaItem(library.id);
    const exception = await getTestPrisma().lifecycleException.create({
      data: { userId: user.id, mediaItemId: item.id },
    });

    await expectJson(await remove(raw, exception.id), 403);
    expect(await getTestPrisma().lifecycleException.count()).toBe(1);
  });
});
