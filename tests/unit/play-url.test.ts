import { describe, it, expect } from "vitest";
import { buildPlayUrl, buildPlayLinks } from "@/lib/play-url";
import type { PlayServer } from "@/lib/play-url";

function makeServer(overrides: Partial<PlayServer> = {}): PlayServer {
  return {
    serverName: "Test Server",
    serverType: "PLEX",
    serverUrl: "http://plex.local:32400",
    machineId: "abc123",
    ratingKey: "12345",
    parentRatingKey: null,
    grandparentRatingKey: null,
    ...overrides,
  };
}

describe("buildPlayUrl", () => {
  describe("PLEX", () => {
    it("builds Plex web app URL when machineId is available", () => {
      const server = makeServer({
        serverType: "PLEX",
        machineId: "machine-abc",
        ratingKey: "999",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe(
        "https://app.plex.tv/desktop/#!/server/machine-abc/details?key=%2Flibrary%2Fmetadata%2F999"
      );
    });

    it("encodes the key parameter properly", () => {
      const server = makeServer({
        serverType: "PLEX",
        machineId: "m1",
        ratingKey: "123",
      });
      const url = buildPlayUrl(server);
      expect(url).toContain("key=%2Flibrary%2Fmetadata%2F123");
    });

    it("uses externalUrl for Plex when specified", () => {
      const server = makeServer({
        serverType: "PLEX",
        machineId: "m1",
        serverUrl: "https://long-hash.plex.direct:32400",
        externalUrl: "https://plex.example.com",
        ratingKey: "123",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe(
        "https://plex.example.com/web/index.html#!/server/details?key=%2Flibrary%2Fmetadata%2F123"
      );
    });

    it("uses externalUrl for Jellyfin when specified", () => {
      const server = makeServer({
        serverType: "JELLYFIN",
        serverUrl: "http://192.168.1.100:8096",
        externalUrl: "https://jellyfin.example.com",
        ratingKey: "abc",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe(
        "https://jellyfin.example.com/web/index.html#/details?id=abc"
      );
    });

    it("uses app.plex.tv when machineId is null", () => {
      const server = makeServer({
        serverType: "PLEX",
        machineId: null,
        serverUrl: "http://192.168.1.100:32400",
        ratingKey: "456",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe(
        "https://app.plex.tv/desktop/#!/details?key=%2Flibrary%2Fmetadata%2F456"
      );
    });

    it("uses app.plex.tv regardless of server URL format", () => {
      const server = makeServer({
        serverType: "PLEX",
        machineId: null,
        serverUrl: "http://plex.local:32400///",
        ratingKey: "789",
      });
      const url = buildPlayUrl(server);
      expect(url).toMatch(/^https:\/\/app\.plex\.tv\/desktop/);
    });
  });

  describe("JELLYFIN", () => {
    it("builds Jellyfin web URL", () => {
      const server = makeServer({
        serverType: "JELLYFIN",
        serverUrl: "http://jellyfin.local:8096",
        ratingKey: "item-abc-123",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe(
        "http://jellyfin.local:8096/web/index.html#/details?id=item-abc-123"
      );
    });

    it("strips trailing slashes from server URL", () => {
      const server = makeServer({
        serverType: "JELLYFIN",
        serverUrl: "http://jellyfin.local:8096/",
        ratingKey: "item-456",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe(
        "http://jellyfin.local:8096/web/index.html#/details?id=item-456"
      );
    });
  });

  describe("EMBY", () => {
    it("builds Emby web URL", () => {
      const server = makeServer({
        serverType: "EMBY",
        serverUrl: "http://emby.local:8920",
        ratingKey: "emby-item-789",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe(
        "http://emby.local:8920/web/index.html#!/item?id=emby-item-789"
      );
    });

    it("strips trailing slashes from server URL", () => {
      const server = makeServer({
        serverType: "EMBY",
        serverUrl: "http://emby.local:8920//",
        ratingKey: "emby-item",
      });
      const url = buildPlayUrl(server);
      expect(url).toMatch(/^http:\/\/emby\.local:8920\/web\//);
    });
  });

  describe("unknown server type", () => {
    it("returns base URL for unknown server types", () => {
      const server = makeServer({
        serverType: "UNKNOWN",
        serverUrl: "http://media.local:9000",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe("http://media.local:9000");
    });

    it("strips trailing slashes for unknown server types", () => {
      const server = makeServer({
        serverType: "OTHER",
        serverUrl: "http://media.local:9000/",
      });
      const url = buildPlayUrl(server);
      expect(url).toBe("http://media.local:9000");
    });
  });
});

describe("buildPlayLinks", () => {
  it("returns empty array for empty servers", () => {
    const result = buildPlayLinks([], [["Movie", "ratingKey"]]);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty levels", () => {
    const server = makeServer();
    const result = buildPlayLinks([server], []);
    expect(result).toEqual([]);
  });

  it("creates a single link for a single level", () => {
    const server = makeServer({ ratingKey: "100" });
    const links = buildPlayLinks([server], [["Movie", "ratingKey"]]);
    expect(links).toHaveLength(1);
    expect(links[0].ratingKey).toBe("100");
    expect(links[0].label).toBe("Movie");
  });

  it("creates multiple links for multiple levels with available keys", () => {
    const server = makeServer({
      ratingKey: "100",
      parentRatingKey: "50",
      grandparentRatingKey: "10",
    });
    const links = buildPlayLinks(
      [server],
      [
        ["Episode", "ratingKey"],
        ["Season", "parentRatingKey"],
        ["Series", "grandparentRatingKey"],
      ]
    );
    expect(links).toHaveLength(3);
    expect(links[0].ratingKey).toBe("100");
    expect(links[0].label).toBe("Episode");
    expect(links[1].ratingKey).toBe("50");
    expect(links[1].label).toBe("Season");
    expect(links[2].ratingKey).toBe("10");
    expect(links[2].label).toBe("Series");
  });

  it("skips levels where the key field is null", () => {
    const server = makeServer({
      ratingKey: "100",
      parentRatingKey: null,
      grandparentRatingKey: "10",
    });
    const links = buildPlayLinks(
      [server],
      [
        ["Episode", "ratingKey"],
        ["Season", "parentRatingKey"],
        ["Series", "grandparentRatingKey"],
      ]
    );
    expect(links).toHaveLength(2);
    expect(links[0].label).toBe("Episode");
    expect(links[1].label).toBe("Series");
  });

  it("handles multiple servers", () => {
    const server1 = makeServer({
      serverName: "Server1",
      ratingKey: "100",
      parentRatingKey: "50",
    });
    const server2 = makeServer({
      serverName: "Server2",
      ratingKey: "200",
      parentRatingKey: "75",
    });
    const links = buildPlayLinks(
      [server1, server2],
      [
        ["Episode", "ratingKey"],
        ["Season", "parentRatingKey"],
      ]
    );
    expect(links).toHaveLength(4);
    expect(links[0].serverName).toBe("Server1");
    expect(links[0].ratingKey).toBe("100");
    expect(links[0].label).toBe("Episode");
    expect(links[1].serverName).toBe("Server1");
    expect(links[1].ratingKey).toBe("50");
    expect(links[1].label).toBe("Season");
    expect(links[2].serverName).toBe("Server2");
    expect(links[2].ratingKey).toBe("200");
    expect(links[2].label).toBe("Episode");
    expect(links[3].serverName).toBe("Server2");
    expect(links[3].ratingKey).toBe("75");
    expect(links[3].label).toBe("Season");
  });

  it("preserves original server properties in created links", () => {
    const server = makeServer({
      serverName: "My Plex",
      serverType: "PLEX",
      serverUrl: "http://plex.local:32400",
      machineId: "m123",
      ratingKey: "100",
      parentRatingKey: "50",
    });
    const links = buildPlayLinks([server], [["Season", "parentRatingKey"]]);
    expect(links).toHaveLength(1);
    expect(links[0].serverName).toBe("My Plex");
    expect(links[0].serverType).toBe("PLEX");
    expect(links[0].serverUrl).toBe("http://plex.local:32400");
    expect(links[0].machineId).toBe("m123");
    // ratingKey is overridden to the parentRatingKey value
    expect(links[0].ratingKey).toBe("50");
  });

  it("does not mutate the original server objects", () => {
    const server = makeServer({
      ratingKey: "100",
      parentRatingKey: "50",
    });
    buildPlayLinks([server], [["Season", "parentRatingKey"]]);
    // Original server should be unchanged
    expect(server.ratingKey).toBe("100");
  });
});
