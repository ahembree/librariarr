import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAiToolMap } from "@/lib/ai/tools";
import { getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

const tools = getAiToolMap();

async function seedLibrary(userId: string) {
  const server = await createTestServer(userId);
  const lib = await createTestLibrary(server.id);
  await createTestMediaItem(lib.id, {
    title: "A", resolution: "4k", videoCodec: "hevc", fileSize: BigInt(5_000_000_000), playCount: 0, genres: ["Action"],
  });
  await createTestMediaItem(lib.id, {
    title: "B", resolution: "1080", videoCodec: "h264", fileSize: BigInt(2_000_000_000), playCount: 3, genres: ["Drama"],
  });
  return server;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
beforeEach(cleanDatabase);
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("ai/tools", () => {
  it("get_library_overview reports counts and storage", async () => {
    const user = await createTestUser();
    await seedLibrary(user.id);
    const res = await tools.get("get_library_overview")!.execute(user.id, {});
    const data = res.data as any;
    expect(data.counts.movies).toBe(2);
    expect(data.storageGB.total).toBeGreaterThan(0);
    expect(res.evidence?.kind).toBe("overview");
  });

  it("get_breakdown by resolution returns normalized values", async () => {
    const user = await createTestUser();
    await seedLibrary(user.id);
    const res = await tools.get("get_breakdown")!.execute(user.id, { dimension: "resolution" });
    const data = res.data as any;
    expect(data.dimension).toBe("Resolution");
    expect(data.rows.map((r: any) => r.value)).toContain("4K");
  });

  it("get_breakdown rejects an unknown dimension", async () => {
    const user = await createTestUser();
    const res = await tools.get("get_breakdown")!.execute(user.id, { dimension: "bogus" });
    expect((res.data as any).error).toContain("Unknown dimension");
  });

  it("get_cross_tab returns resolution × codec combinations", async () => {
    const user = await createTestUser();
    await seedLibrary(user.id);
    const res = await tools.get("get_cross_tab")!.execute(user.id, {
      dimension1: "resolution",
      dimension2: "videoCodec",
    });
    const data = res.data as any;
    expect(data.dimension1).toBe("Resolution");
    expect(data.dimension2).toBe("Video Codec");
    expect(data.rows.length).toBeGreaterThan(0);
  });

  it("search_media filters items and rejects Arr-only fields", async () => {
    const user = await createTestUser();
    await seedLibrary(user.id);
    const res = await tools.get("search_media")!.execute(user.id, {
      mediaTypes: ["MOVIE"],
      filters: [{ field: "playCount", operator: "equals", value: 0 }],
    });
    const data = res.data as any;
    expect(data.count).toBe(1);
    expect(data.items[0].title).toBe("A");

    const bad = await tools.get("search_media")!.execute(user.id, {
      filters: [{ field: "arrMonitored", operator: "equals", value: "true" }],
    });
    expect((bad.data as any).error).toContain("not available");
  });

  it("search_media collapses multi-server duplicates by dedupKey", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    // Two enabled servers → cross-server dedup applies (dedupStats defaults on).
    const serverA = await createTestServer(user.id, { name: "Plex" });
    const serverB = await createTestServer(user.id, { name: "Jellyfin" });
    const libA = await createTestLibrary(serverA.id);
    const libB = await createTestLibrary(serverB.id);
    // Same movie on both servers → shared dedupKey, one marked canonical.
    const a = await createTestMediaItem(libA.id, { title: "Dune", year: 2021, fileSize: BigInt(8_000_000_000) });
    const b = await createTestMediaItem(libB.id, { title: "Dune", year: 2021, fileSize: BigInt(8_000_000_000) });
    await prisma.mediaItem.update({ where: { id: a.id }, data: { dedupKey: "dune-2021", dedupCanonical: true } });
    await prisma.mediaItem.update({ where: { id: b.id }, data: { dedupKey: "dune-2021", dedupCanonical: false } });

    const res = await tools.get("search_media")!.execute(user.id, {
      mediaTypes: ["MOVIE"],
      filters: [{ field: "title", operator: "equals", value: "Dune" }],
    });
    const data = res.data as any;
    // Without dedup this would be 2 (one row per server); the tool must collapse
    // to the single logical title so counts match the other aggregation tools.
    expect(data.count).toBe(1);
    expect(data.items[0].title).toBe("Dune");
  });

  it("search_media sorts fileSize numerically, not lexicographically", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);
    // 15 GB must sort above 2 GB above 900 MB. Lexicographic string compare on
    // the serialized BigInt ("15000000000" < "2000000000") would put 2 GB first.
    await createTestMediaItem(lib.id, { title: "Two GB", fileSize: BigInt(2_000_000_000) });
    await createTestMediaItem(lib.id, { title: "Fifteen GB", fileSize: BigInt(15_000_000_000) });
    await createTestMediaItem(lib.id, { title: "Point Nine GB", fileSize: BigInt(900_000_000) });

    // No mediaTypes → the grouped/combined path runs sortCombinedResults.
    const res = await tools.get("search_media")!.execute(user.id, {
      sortBy: "fileSize",
      sortOrder: "desc",
    });
    const data = res.data as any;
    expect(data.items.map((i: any) => i.title)).toEqual(["Fifteen GB", "Two GB", "Point Nine GB"]);
  });

  it("returns a no-servers note when nothing is connected", async () => {
    const user = await createTestUser();
    const res = await tools.get("get_breakdown")!.execute(user.id, { dimension: "resolution" });
    expect((res.data as any).note).toContain("No media servers");
  });
});
