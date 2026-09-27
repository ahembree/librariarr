import { describe, it, expect } from "vitest";
import { actionTargetTitle, actionTitleSnapshot, snapshotTargetTitle } from "@/lib/lifecycle/action-target";

// A series action is stored against ONE representative episode of the show.
const episode = {
  id: "ep-1",
  type: "SERIES",
  title: "Pilot",
  parentTitle: "Breaking Bad",
  seasonNumber: 1,
  episodeNumber: 1,
};

describe("actionTargetTitle", () => {
  it("names a whole-series action by the show, never the representative episode", () => {
    for (const actionType of ["DELETE_SONARR", "UNMONITOR_SONARR", "SEARCH_SONARR", "CHANGE_QUALITY_PROFILE_SONARR", "DO_NOTHING"]) {
      expect(actionTargetTitle({ actionType, matchedMediaItemIds: ["ep-1", "ep-2"], mediaItem: episode })).toBe(
        "Breaking Bad",
      );
    }
  });

  it("names a file delete across several episodes by the show", () => {
    expect(
      actionTargetTitle({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["ep-1", "ep-2"], mediaItem: episode }),
    ).toBe("Breaking Bad");
  });

  it("names a file delete on exactly its own episode by show and SxxExx", () => {
    expect(
      actionTargetTitle({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["ep-1"], mediaItem: episode }),
    ).toBe("Breaking Bad S01E01");
  });

  it("names a whole-series action by the show even when it matched one episode", () => {
    expect(actionTargetTitle({ actionType: "DELETE_SONARR", matchedMediaItemIds: ["ep-1"], mediaItem: episode })).toBe(
      "Breaking Bad",
    );
  });

  it("recognises a Sonarr action on a row that carries no type", () => {
    const untyped = { ...episode, type: undefined };
    expect(actionTargetTitle({ actionType: "DELETE_SONARR", matchedMediaItemIds: [], mediaItem: untyped })).toBe(
      "Breaking Bad",
    );
  });

  it("leaves a movie or a track its own title", () => {
    expect(
      actionTargetTitle({
        actionType: "DELETE_RADARR",
        mediaItem: { id: "m", type: "MOVIE", title: "Arrival", parentTitle: null },
      }),
    ).toBe("Arrival");
    expect(
      actionTargetTitle({
        actionType: "DELETE_FILES_LIDARR",
        matchedMediaItemIds: [],
        mediaItem: { id: "t", type: "MUSIC", title: "Teardrop", parentTitle: "Massive Attack" },
      }),
    ).toBe("Teardrop");
  });
});

describe("actionTitleSnapshot", () => {
  it("records a series action as its show, the shape scheduling writes", () => {
    expect(
      actionTitleSnapshot({ actionType: "DELETE_SONARR", matchedMediaItemIds: ["ep-1", "ep-2"], mediaItem: episode }),
    ).toEqual({
      mediaItemTitle: "Breaking Bad",
      mediaItemParentTitle: null,
      mediaItemSeasonNumber: null,
      mediaItemEpisodeNumber: null,
    });
  });

  it("keeps the numbers of the one episode a file delete acted on", () => {
    expect(
      actionTitleSnapshot({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["ep-1"], mediaItem: episode }),
    ).toEqual({
      mediaItemTitle: "Breaking Bad",
      mediaItemParentTitle: null,
      mediaItemSeasonNumber: 1,
      mediaItemEpisodeNumber: 1,
    });
  });

  it("records anything else as the row's own titles", () => {
    expect(
      actionTitleSnapshot({
        actionType: "DELETE_RADARR",
        mediaItem: { id: "m", type: "MOVIE", title: "Arrival", parentTitle: null },
      }),
    ).toEqual({ mediaItemTitle: "Arrival", mediaItemParentTitle: null });
    expect(
      actionTitleSnapshot({
        actionType: "DELETE_FILES_LIDARR",
        matchedMediaItemIds: ["t"],
        mediaItem: { id: "t", type: "MUSIC", title: "Teardrop", parentTitle: "Massive Attack" },
      }),
    ).toEqual({ mediaItemTitle: "Teardrop", mediaItemParentTitle: "Massive Attack" });
  });
});

describe("snapshotTargetTitle", () => {
  it("names a show-level action by its show once the episode is gone", () => {
    expect(snapshotTargetTitle({ mediaItemTitle: "Breaking Bad", mediaItemParentTitle: null })).toBe("Breaking Bad");
  });

  it("names a one-episode action by show and SxxExx once the episode is gone", () => {
    expect(
      snapshotTargetTitle({
        mediaItemTitle: "Breaking Bad",
        mediaItemParentTitle: null,
        mediaItemSeasonNumber: 2,
        mediaItemEpisodeNumber: 5,
      }),
    ).toBe("Breaking Bad S02E05");
  });

  it("reads an older episode-level snapshot as its show", () => {
    expect(snapshotTargetTitle({ mediaItemTitle: "Pilot", mediaItemParentTitle: "Breaking Bad" })).toBe("Breaking Bad");
  });
});
