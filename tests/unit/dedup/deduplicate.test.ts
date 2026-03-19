import { describe, it, expect } from "vitest";
import {
  deduplicateItems,
  buildSingleServerPresence,
  createGroupedContext,
  processGroupedItem,
  getGroupServers,
  type DeduplicableItem,
} from "@/lib/dedup/deduplicate";

function makeItem(overrides: Partial<DeduplicableItem> & { id: string }): DeduplicableItem {
  return {
    title: "Default Title",
    year: 2020,
    type: "MOVIE",
    library: {
      mediaServer: { id: "server-1", name: "Server One", type: "PLEX" },
    },
    ...overrides,
  };
}

function makeServer(id: string, name: string, type = "PLEX") {
  return { id, name, type };
}

describe("deduplicateItems", () => {
  describe("basic dedup", () => {
    it("returns empty result for empty input", () => {
      const result = deduplicateItems([], null);
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("returns single item unchanged with one server entry", () => {
      const items = [makeItem({ id: "1", title: "Movie" })];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0].servers).toHaveLength(1);
      expect(result.items[0].servers[0].serverId).toBe("server-1");
      expect(result.items[0].matchedBy).toBeNull();
    });

    it("keeps two different items separate", () => {
      const items = [
        makeItem({ id: "1", title: "Movie A", year: 2020 }),
        makeItem({ id: "2", title: "Movie B", year: 2021 }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
    });
  });

  describe("external ID matching", () => {
    it("deduplicates items with same TMDB ID from different servers", () => {
      const items = [
        makeItem({
          id: "1",
          title: "The Matrix",
          externalIds: [{ source: "tmdb", externalId: "603" }],
          library: { mediaServer: makeServer("s1", "Server One") },
        }),
        makeItem({
          id: "2",
          title: "The Matrix",
          externalIds: [{ source: "tmdb", externalId: "603" }],
          library: { mediaServer: makeServer("s2", "Server Two") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].servers).toHaveLength(2);
      expect(result.items[0].matchedBy).toBe("TMDB ID");
    });

    it("deduplicates items with same IMDB ID from different servers", () => {
      const items = [
        makeItem({
          id: "1",
          title: "Film",
          externalIds: [{ source: "imdb", externalId: "tt0001" }],
          library: { mediaServer: makeServer("s1", "Server A") },
        }),
        makeItem({
          id: "2",
          title: "Film",
          externalIds: [{ source: "imdb", externalId: "tt0001" }],
          library: { mediaServer: makeServer("s2", "Server B") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].matchedBy).toBe("IMDB ID");
    });

    it("deduplicates when one server has TMDB and another has IMDB but shared TMDB matches", () => {
      const items = [
        makeItem({
          id: "1",
          title: "Movie",
          externalIds: [
            { source: "tmdb", externalId: "100" },
            { source: "imdb", externalId: "tt100" },
          ],
          library: { mediaServer: makeServer("s1", "Server One") },
        }),
        makeItem({
          id: "2",
          title: "Movie",
          externalIds: [{ source: "tmdb", externalId: "100" }],
          library: { mediaServer: makeServer("s2", "Server Two") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].servers).toHaveLength(2);
    });

    it("uses title+year fallback when no external IDs", () => {
      const items = [
        makeItem({
          id: "1",
          title: "Same Movie",
          year: 2020,
          library: { mediaServer: makeServer("s1", "A") },
        }),
        makeItem({
          id: "2",
          title: "Same Movie",
          year: 2020,
          library: { mediaServer: makeServer("s2", "B") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].matchedBy).toBe("Title + Year");
    });

    it("does not deduplicate items with different titles and no external IDs", () => {
      const items = [
        makeItem({ id: "1", title: "Movie A", year: 2020, library: { mediaServer: makeServer("s1", "A") } }),
        makeItem({ id: "2", title: "Movie B", year: 2020, library: { mediaServer: makeServer("s2", "B") } }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(2);
    });
  });

  describe("preferred server logic", () => {
    it("uses preferred title server item as primary", () => {
      const items = [
        makeItem({
          id: "1",
          title: "Title From Server 1",
          externalIds: [{ source: "tmdb", externalId: "100" }],
          library: { mediaServer: makeServer("s1", "Server One") },
        }),
        makeItem({
          id: "2",
          title: "Title From Server 2",
          externalIds: [{ source: "tmdb", externalId: "100" }],
          library: { mediaServer: makeServer("s2", "Server Two") },
        }),
      ];
      const result = deduplicateItems(items, "s2");
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Title From Server 2");
    });

    it("keeps first item as primary when no preferred server matches", () => {
      const items = [
        makeItem({
          id: "1",
          title: "First",
          externalIds: [{ source: "tmdb", externalId: "100" }],
          library: { mediaServer: makeServer("s1", "A") },
        }),
        makeItem({
          id: "2",
          title: "Second",
          externalIds: [{ source: "tmdb", externalId: "100" }],
          library: { mediaServer: makeServer("s2", "B") },
        }),
      ];
      const result = deduplicateItems(items, "s3");
      expect(result.items[0].title).toBe("First");
    });

    it("overlays artwork from preferred artwork server", () => {
      const items = [
        makeItem({
          id: "1",
          title: "Movie",
          externalIds: [{ source: "tmdb", externalId: "100" }],
          library: { mediaServer: makeServer("s1", "A") },
        }) as DeduplicableItem & { thumbUrl: string },
        makeItem({
          id: "2",
          title: "Movie",
          externalIds: [{ source: "tmdb", externalId: "100" }],
          library: { mediaServer: makeServer("s2", "B") },
        }) as DeduplicableItem & { thumbUrl: string },
      ];
      // Add artwork fields
      (items[0] as unknown as Record<string, unknown>).thumbUrl = "/thumb/s1";
      (items[1] as unknown as Record<string, unknown>).thumbUrl = "/thumb/s2";

      const result = deduplicateItems(items, "s1", "s2");
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Movie"); // primary from s1
      expect((result.items[0] as unknown as Record<string, unknown>).thumbUrl).toBe("/thumb/s2"); // artwork from s2
    });
  });

  describe("series dedup", () => {
    it("deduplicates episodes with same parentTitle+season+episode", () => {
      const items = [
        makeItem({
          id: "1",
          title: "Ep 1",
          type: "SERIES",
          parentTitle: "Breaking Bad",
          seasonNumber: 1,
          episodeNumber: 1,
          library: { mediaServer: makeServer("s1", "Server A") },
        }),
        makeItem({
          id: "2",
          title: "Pilot",
          type: "SERIES",
          parentTitle: "Breaking Bad",
          seasonNumber: 1,
          episodeNumber: 1,
          library: { mediaServer: makeServer("s2", "Server B") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].matchedBy).toBe("Series + Episode");
    });

    it("keeps different episodes separate", () => {
      const items = [
        makeItem({
          id: "1",
          type: "SERIES",
          parentTitle: "Show",
          seasonNumber: 1,
          episodeNumber: 1,
          library: { mediaServer: makeServer("s1", "A") },
        }),
        makeItem({
          id: "2",
          type: "SERIES",
          parentTitle: "Show",
          seasonNumber: 1,
          episodeNumber: 2,
          library: { mediaServer: makeServer("s1", "A") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(2);
    });
  });

  describe("music dedup", () => {
    it("deduplicates tracks with same artist+title", () => {
      const items = [
        makeItem({
          id: "1",
          type: "MUSIC",
          title: "Bohemian Rhapsody",
          parentTitle: "Queen",
          library: { mediaServer: makeServer("s1", "A") },
        }),
        makeItem({
          id: "2",
          type: "MUSIC",
          title: "Bohemian Rhapsody",
          parentTitle: "Queen",
          library: { mediaServer: makeServer("s2", "B") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].matchedBy).toBe("Artist + Track");
    });
  });

  describe("server presence", () => {
    it("does not add duplicate server entries for same server", () => {
      const items = [
        makeItem({
          id: "1",
          title: "Movie",
          year: 2020,
          library: { mediaServer: makeServer("s1", "A") },
        }),
        makeItem({
          id: "2",
          title: "Movie",
          year: 2020,
          library: { mediaServer: makeServer("s1", "A") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].servers).toHaveLength(1);
    });

    it("sorts servers alphabetically by name", () => {
      const items = [
        makeItem({
          id: "1",
          title: "M",
          externalIds: [{ source: "tmdb", externalId: "1" }],
          library: { mediaServer: makeServer("s3", "Zulu") },
        }),
        makeItem({
          id: "2",
          title: "M",
          externalIds: [{ source: "tmdb", externalId: "1" }],
          library: { mediaServer: makeServer("s1", "Alpha") },
        }),
        makeItem({
          id: "3",
          title: "M",
          externalIds: [{ source: "tmdb", externalId: "1" }],
          library: { mediaServer: makeServer("s2", "Mike") },
        }),
      ];
      const result = deduplicateItems(items, null);
      expect(result.items[0].servers.map((s) => s.serverName)).toEqual([
        "Alpha",
        "Mike",
        "Zulu",
      ]);
    });
  });
});

describe("buildSingleServerPresence", () => {
  it("returns array with single ServerPresence", () => {
    const result = buildSingleServerPresence("s1", "Server", "PLEX", "item1");
    expect(result).toEqual([
      { serverId: "s1", serverName: "Server", serverType: "PLEX", mediaItemId: "item1" },
    ]);
  });

  it("returns all fields correctly", () => {
    const result = buildSingleServerPresence("id-abc", "My Jellyfin", "JELLYFIN", "media-xyz");
    expect(result).toHaveLength(1);
    expect(result[0].serverId).toBe("id-abc");
    expect(result[0].serverName).toBe("My Jellyfin");
    expect(result[0].serverType).toBe("JELLYFIN");
    expect(result[0].mediaItemId).toBe("media-xyz");
  });
});

describe("createGroupedContext", () => {
  it("returns empty context", () => {
    const ctx = createGroupedContext();
    expect(ctx.seenKeys.size).toBe(0);
    expect(ctx.servers.size).toBe(0);
    expect(ctx.preferredTitle).toBeNull();
    expect(ctx.preferredThumbUrl).toBeNull();
    expect(ctx.preferredMediaItemId).toBeNull();
  });
});

describe("processGroupedItem", () => {
  it("returns true for a new unique key", () => {
    const ctx = createGroupedContext();
    const result = processGroupedItem(
      ctx,
      { id: "1", seasonNumber: 1, episodeNumber: 1 },
      "s1",
      "Server",
      "PLEX",
      null
    );
    expect(result).toBe(true);
    expect(ctx.seenKeys.has("s1e1")).toBe(true);
  });

  it("returns false for a duplicate key", () => {
    const ctx = createGroupedContext();
    processGroupedItem(ctx, { id: "1", seasonNumber: 1, episodeNumber: 1 }, "s1", "A", "PLEX", null);
    const result = processGroupedItem(ctx, { id: "2", seasonNumber: 1, episodeNumber: 1 }, "s2", "B", "PLEX", null);
    expect(result).toBe(false);
  });

  it("tracks server in context", () => {
    const ctx = createGroupedContext();
    processGroupedItem(ctx, { id: "1", seasonNumber: 1, episodeNumber: 1 }, "s1", "My Server", "PLEX", null);
    expect(ctx.servers.has("s1")).toBe(true);
    expect(ctx.servers.get("s1")!.serverName).toBe("My Server");
  });

  it("does not add duplicate server entries", () => {
    const ctx = createGroupedContext();
    processGroupedItem(ctx, { id: "1", seasonNumber: 1, episodeNumber: 1 }, "s1", "A", "PLEX", null);
    processGroupedItem(ctx, { id: "2", seasonNumber: 1, episodeNumber: 2 }, "s1", "A", "PLEX", null);
    expect(ctx.servers.size).toBe(1);
  });

  it("tracks preferred title from preferred server", () => {
    const ctx = createGroupedContext();
    processGroupedItem(
      ctx,
      { id: "1", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 1 },
      "s1",
      "Server",
      "PLEX",
      "s1"
    );
    expect(ctx.preferredTitle).toBe("Breaking Bad");
  });

  it("does not set preferredTitle when server is not preferred", () => {
    const ctx = createGroupedContext();
    processGroupedItem(
      ctx,
      { id: "1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 },
      "s1",
      "Server",
      "PLEX",
      "s2"
    );
    expect(ctx.preferredTitle).toBeNull();
  });

  it("tracks preferred thumb from preferred server", () => {
    const ctx = createGroupedContext();
    processGroupedItem(
      ctx,
      { id: "1", parentThumbUrl: "/thumb/parent", seasonNumber: 1, episodeNumber: 1 },
      "s1",
      "Server",
      "PLEX",
      "s1"
    );
    expect(ctx.preferredThumbUrl).toBe("/thumb/parent");
    expect(ctx.preferredMediaItemId).toBe("1");
  });

  it("falls back to thumbUrl when no parentThumbUrl", () => {
    const ctx = createGroupedContext();
    processGroupedItem(
      ctx,
      { id: "1", thumbUrl: "/thumb/item", seasonNumber: 1, episodeNumber: 1 },
      "s1",
      "Server",
      "PLEX",
      "s1"
    );
    expect(ctx.preferredThumbUrl).toBe("/thumb/item");
  });

  it("uses title as uniqueKey for music tracks", () => {
    const ctx = createGroupedContext();
    const result1 = processGroupedItem(
      ctx,
      { id: "1", title: "Song A" },
      "s1",
      "Server",
      "PLEX",
      null
    );
    const result2 = processGroupedItem(
      ctx,
      { id: "2", title: "Song A" },
      "s2",
      "Server B",
      "PLEX",
      null
    );
    expect(result1).toBe(true);
    expect(result2).toBe(false);
  });

  it("falls back to item id when no season/episode and no title", () => {
    const ctx = createGroupedContext();
    const result = processGroupedItem(
      ctx,
      { id: "unique-id-123" },
      "s1",
      "Server",
      "PLEX",
      null
    );
    expect(result).toBe(true);
    expect(ctx.seenKeys.has("unique-id-123")).toBe(true);
  });
});

describe("getGroupServers", () => {
  it("returns empty array for empty context", () => {
    const ctx = createGroupedContext();
    expect(getGroupServers(ctx)).toEqual([]);
  });

  it("returns servers sorted alphabetically", () => {
    const ctx = createGroupedContext();
    processGroupedItem(ctx, { id: "1", seasonNumber: 1, episodeNumber: 1 }, "s2", "Zulu", "PLEX", null);
    processGroupedItem(ctx, { id: "2", seasonNumber: 1, episodeNumber: 2 }, "s1", "Alpha", "PLEX", null);
    const servers = getGroupServers(ctx);
    expect(servers.map((s) => s.serverName)).toEqual(["Alpha", "Zulu"]);
  });
});
