import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
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

import { loadGenreSpellings } from "@/lib/filters/genre-spellings";
import { appCache } from "@/lib/cache/memory-cache";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";

describe("loadGenreSpellings", () => {
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    appCache.clear();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    libraryId = (await createTestLibrary(server.id)).id;
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns undefined and makes no lookup without a genre filter", async () => {
    await createTestMediaItem(libraryId, { genres: ["Drama"] });
    expect(await loadGenreSpellings(new URLSearchParams())).toBeUndefined();
    expect(await loadGenreSpellings(new URLSearchParams("genre="))).toBeUndefined();
    expect(appCache.get("distinct-values:genres")).toBeUndefined();
  });

  it("groups every stored spelling under its lower-cased form", async () => {
    await createTestMediaItem(libraryId, { genres: ["Sci-Fi", "Drama"] });
    await createTestMediaItem(libraryId, { genres: ["sci-fi"] });
    await createTestMediaItem(libraryId, { genres: ["SCI-FI", "drama"] });
    await createTestMediaItem(libraryId, { title: "No genres" });

    const map = await loadGenreSpellings(new URLSearchParams("genre=Sci-Fi"));
    expect(map).toBeDefined();
    expect(map!.get("sci-fi")?.sort()).toEqual(["SCI-FI", "Sci-Fi", "sci-fi"]);
    expect(map!.get("drama")?.sort()).toEqual(["Drama", "drama"]);
    expect(map!.size).toBe(2);
  });

  it("ignores rows whose genres column is not an array", async () => {
    const { getTestPrisma } = await import("../../setup/test-db");
    const item = await createTestMediaItem(libraryId, { genres: ["Drama"] });
    await getTestPrisma().$executeRaw`UPDATE "MediaItem" SET genres = '"Action"'::jsonb WHERE id = ${item.id}`;
    const map = await loadGenreSpellings(new URLSearchParams("genre=x"));
    expect(map!.size).toBe(0);
  });

  it("is cached until the media caches are invalidated", async () => {
    await createTestMediaItem(libraryId, { genres: ["Drama"] });
    const first = await loadGenreSpellings(new URLSearchParams("genre=Drama"));
    expect(first!.has("comedy")).toBe(false);

    await createTestMediaItem(libraryId, { genres: ["Comedy"] });
    const cached = await loadGenreSpellings(new URLSearchParams("genre=Drama"));
    expect(cached!.has("comedy")).toBe(false);

    invalidateMediaCaches();
    const fresh = await loadGenreSpellings(new URLSearchParams("genre=Drama"));
    expect(fresh!.has("comedy")).toBe(true);
  });
});
