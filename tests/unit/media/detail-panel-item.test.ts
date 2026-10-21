import { describe, it, expect } from "vitest";
import {
  buildDetailPanelItem,
  detailPanelUrl,
  groupOfRow,
  toDetailPanelMediaType,
  sessionMediaType,
} from "@/lib/media/detail-panel-item";
import type { MediaItemWithRelations } from "@/lib/types";

const episode = {
  id: "ep1",
  title: "Pilot",
  parentTitle: "The Show",
  type: "SERIES",
  fileSize: "100",
  playCount: 3,
  lastPlayedAt: "2026-01-01T00:00:00.000Z",
  summary: "Episode blurb",
  addedAt: "2025-06-01T00:00:00.000Z",
} as unknown as MediaItemWithRelations;

describe("groupOfRow", () => {
  it("is undefined for a row that is one item", () => {
    expect(groupOfRow({ title: "A Movie" })).toBeUndefined();
    expect(groupOfRow({ title: "A Movie", matchedEpisodes: 0 })).toBeUndefined();
  });

  it("names a grouped row by its group, whether it carries the parent or not", () => {
    expect(groupOfRow({ title: "The Show", parentTitle: null, matchedEpisodes: 4 })?.title).toBe("The Show");
    // A music group row is its representative track with the artist as parent.
    expect(groupOfRow({ title: "Track", parentTitle: "Artist", matchedEpisodes: 9 })?.title).toBe("Artist");
  });

  it("carries the row's totals", () => {
    expect(groupOfRow({
      title: "The Show", matchedEpisodes: 4, fileSize: "999", playCount: 12, lastPlayedAt: "2026-02-02",
    })).toEqual({ title: "The Show", memberCount: 4, fileSize: "999", playCount: 12, lastPlayedAt: "2026-02-02" });
  });

  it("keeps the row's added date only when it has one", () => {
    expect(groupOfRow({ title: "S", matchedEpisodes: 2 })).not.toHaveProperty("addedAt");
    expect(groupOfRow({ title: "S", matchedEpisodes: 2, addedAt: "2026-01-01" })?.addedAt).toBe("2026-01-01");
  });

  it("keeps the row's summary only when it has one", () => {
    expect(groupOfRow({ title: "S", matchedEpisodes: 2 })).not.toHaveProperty("summary");
    expect(groupOfRow({ title: "S", matchedEpisodes: 2, summary: "Show blurb" })?.summary).toBe("Show blurb");
  });
});

describe("buildDetailPanelItem", () => {
  it("returns the record untouched without a group", () => {
    expect(buildDetailPanelItem(episode)).toBe(episode);
  });

  it("lays the group over the representative record", () => {
    const item = buildDetailPanelItem(episode, { title: "The Show", memberCount: 10, fileSize: "5000" });
    expect(item.id).toBe("ep1");
    expect(item.title).toBe("The Show");
    expect(item.parentTitle).toBeNull();
    expect(item.matchedEpisodes).toBe(10);
    expect(item.fileSize).toBe("5000");
    // The episode's own plays are not the group's.
    expect(item.playCount).toBe(0);
    expect(item.lastPlayedAt).toBeNull();
    expect(item.summary).toBe("Episode blurb");
    expect(item.addedAt).toBe(episode.addedAt);
  });

  it("uses the group's added date when it has one", () => {
    const item = buildDetailPanelItem(episode, { title: "The Show", memberCount: 2, addedAt: "2020-05-05" });
    expect(item.addedAt).toBe("2020-05-05");
  });

  it("uses the group's plays and summary when it has them", () => {
    const item = buildDetailPanelItem(episode, {
      title: "The Show", memberCount: 2, playCount: 7, lastPlayedAt: "2026-03-03", summary: null,
    });
    expect(item.playCount).toBe(7);
    expect(item.lastPlayedAt).toBe("2026-03-03");
    expect(item.summary).toBeNull();
    // No group size keeps the record's.
    expect(item.fileSize).toBe("100");
  });
});

describe("detailPanelUrl", () => {
  it("links an item to its own page", () => {
    expect(detailPanelUrl("MOVIE", "x", false)).toBe("/library/movies/x");
    expect(detailPanelUrl("SERIES", "x", false)).toBe("/library/series/episode/x");
    expect(detailPanelUrl("MUSIC", "x", false)).toBe("/library/music/track/x");
  });

  it("links a group to its show or artist page", () => {
    expect(detailPanelUrl("SERIES", "x", true)).toBe("/library/series/show/x");
    expect(detailPanelUrl("MUSIC", "x", true)).toBe("/library/music/artist/x");
    expect(detailPanelUrl("MOVIE", "x", true)).toBe("/library/movies/x");
  });
});

describe("toDetailPanelMediaType", () => {
  it("falls back to MOVIE for anything else", () => {
    expect(toDetailPanelMediaType("SERIES")).toBe("SERIES");
    expect(toDetailPanelMediaType("MUSIC")).toBe("MUSIC");
    expect(toDetailPanelMediaType("MOVIE")).toBe("MOVIE");
    expect(toDetailPanelMediaType(undefined)).toBe("MOVIE");
  });
});

describe("sessionMediaType", () => {
  it("maps a playback session's item type to its library type", () => {
    expect(sessionMediaType("movie")).toBe("MOVIE");
    expect(sessionMediaType("episode")).toBe("SERIES");
    expect(sessionMediaType("Track")).toBe("MUSIC");
    expect(sessionMediaType("clip")).toBeNull();
    expect(sessionMediaType(null)).toBeNull();
  });
});
