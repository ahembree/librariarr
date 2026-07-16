import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
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

// Keep artwork-cache side effects off the filesystem.
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));

const mockGetItemMetadata = vi.fn();
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({ getItemMetadata: mockGetItemMetadata })),
}));

// Import after mocks
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";

const movieMeta = (ratingKey: string, over: Record<string, unknown> = {}) => ({
  ratingKey,
  key: `/library/metadata/${ratingKey}`,
  type: "movie",
  title: `Movie ${ratingKey}`,
  year: 2024,
  librarySectionID: 1,
  Guid: [{ id: "tmdb://999" }],
  ...over,
});

async function seed() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  return { user, server, library };
}

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("syncMediaServerItems", () => {
  it("upserts a newly-added item", async () => {
    const { server } = await seed();
    mockGetItemMetadata.mockResolvedValue(movieMeta("m1", { title: "Brand New" }));

    const result = await syncMediaServerItems(server.id, ["m1"], []);

    expect(result.status).toBe("done");
    expect(result.upserted).toBe(1);
    const item = await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m1" } });
    expect(item?.title).toBe("Brand New");
  });

  it("deletes items reported as removed", async () => {
    const { library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "m2", title: "Old" });

    const server = await getTestPrisma().mediaServer.findFirst({});
    const result = await syncMediaServerItems(server!.id, [], ["m2"]);

    expect(result.status).toBe("done");
    expect(result.deleted).toBe(1);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m2" } })).toBeNull();
  });

  it("treats a changed id the server 404s as a deletion", async () => {
    const { server, library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "m3" });
    mockGetItemMetadata.mockRejectedValue({ response: { status: 404 } });

    const result = await syncMediaServerItems(server.id, ["m3"], []);

    expect(result.status).toBe("done");
    expect(result.deleted).toBe(1);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m3" } })).toBeNull();
  });

  it("falls back (never deletes) on a transient fetch error", async () => {
    const { server, library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "m4" });
    mockGetItemMetadata.mockRejectedValue({ response: { status: 500 } });

    const result = await syncMediaServerItems(server.id, ["m4"], []);

    expect(result.status).toBe("fell-back");
    // The item must NOT have been deleted on a transient error.
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m4" } })).not.toBeNull();
  });

  it("skips when a full sync is already running for the server", async () => {
    const { server } = await seed();
    await getTestPrisma().syncJob.create({
      data: { mediaServerId: server.id, status: "RUNNING" },
    });

    const result = await syncMediaServerItems(server.id, ["m1"], []);

    expect(result.status).toBe("skipped");
    expect(mockGetItemMetadata).not.toHaveBeenCalled();
  });

  it("falls back without fetching when the change set exceeds the threshold", async () => {
    const { server } = await seed();
    const many = Array.from({ length: 150 }, (_, i) => `x${i}`);

    const result = await syncMediaServerItems(server.id, many, []);

    expect(result.status).toBe("fell-back");
    expect(mockGetItemMetadata).not.toHaveBeenCalled();
  });

  it("falls back when a new item can't be mapped to a known library", async () => {
    const { server } = await seed();
    // No existing row and a librarySectionID that matches no library.
    mockGetItemMetadata.mockResolvedValue(movieMeta("m9", { librarySectionID: 999 }));

    const result = await syncMediaServerItems(server.id, ["m9"], []);

    expect(result.status).toBe("fell-back");
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m9" } })).toBeNull();
  });
});
