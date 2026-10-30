import { describe, it, expect } from "vitest";
import {
  RECENTLY_ADDED_LIMIT,
  libraryTileTypes,
  recentlyAddedUrl,
  sparklinesUrl,
} from "@/lib/dashboard/seed-urls";

describe("libraryTileTypes", () => {
  it("lists every type when none exists yet", () => {
    expect(libraryTileTypes([])).toEqual(["MOVIE", "SERIES", "MUSIC"]);
  });

  it("keeps the tiles' order whatever order the types arrive in", () => {
    expect(libraryTileTypes(["MUSIC", "MOVIE"])).toEqual(["MOVIE", "MUSIC"]);
    expect(libraryTileTypes(["SERIES"])).toEqual(["SERIES"]);
  });
});

describe("the dashboard's request URLs", () => {
  // The server render and each zone must build the same string, or the zone
  // misses the seed and fetches again.
  it("builds the sparklines URL the way the tiles always have", () => {
    expect(sparklinesUrl(["MOVIE", "SERIES", "MUSIC"])).toBe(
      "/api/media/stats/sparklines?types=MOVIE%2CSERIES%2CMUSIC",
    );
    expect(sparklinesUrl(["MOVIE"], "srv-1")).toBe("/api/media/stats/sparklines?types=MOVIE&serverId=srv-1");
  });

  it("builds the shelf URL with its limit, then the type and server", () => {
    expect(recentlyAddedUrl()).toBe(`/api/media/recently-added?limit=${RECENTLY_ADDED_LIMIT}`);
    expect(recentlyAddedUrl("SERIES", "srv-1")).toBe(
      `/api/media/recently-added?limit=${RECENTLY_ADDED_LIMIT}&type=SERIES&serverId=srv-1`,
    );
  });
});
