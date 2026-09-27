import { describe, it, expect } from "vitest";
import {
  actionTargetTitle,
  actionTitleSnapshot,
  loneMemberId,
  snapshotTargetTitle,
} from "@/lib/lifecycle/action-target";

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

  it("names a file delete on one OTHER episode after that episode, once the caller resolves it", () => {
    // Series scope forced by an aggregate field: stored against the show's
    // lowest-id episode, acting only on the one episode that matched.
    const action = { actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["ep-10"], mediaItem: episode };
    expect(actionTargetTitle({ ...action, memberEpisode: { title: "Fly", seasonNumber: 3, episodeNumber: 10 } })).toBe(
      "Breaking Bad S03E10",
    );
    // Unresolved, it falls back to the show — never the stored episode's SxxExx.
    expect(actionTargetTitle(action)).toBe("Breaking Bad");
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

  it("keeps the numbers of the episode acted on, not of the one the action is stored against", () => {
    expect(
      actionTitleSnapshot({
        actionType: "DELETE_FILES_SONARR",
        matchedMediaItemIds: ["ep-10"],
        mediaItem: episode,
        memberEpisode: { title: "Fly", seasonNumber: 3, episodeNumber: 10 },
      }),
    ).toMatchObject({ mediaItemTitle: "Breaking Bad", mediaItemSeasonNumber: 3, mediaItemEpisodeNumber: 10 });
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

describe("loneMemberId", () => {
  it("names the one episode a file delete acts on when it is not the action's own", () => {
    expect(loneMemberId({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["ep-10"], mediaItemId: "ep-1" })).toBe(
      "ep-10",
    );
  });

  it("needs nothing looked up for its own episode, several episodes or a whole-series action", () => {
    expect(loneMemberId({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["ep-1"], mediaItemId: "ep-1" })).toBeNull();
    expect(loneMemberId({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["a", "b"], mediaItemId: "ep-1" })).toBeNull();
    expect(loneMemberId({ actionType: "DELETE_SONARR", matchedMediaItemIds: ["ep-10"], mediaItemId: "ep-1" })).toBeNull();
    expect(loneMemberId({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: null, mediaItemId: "ep-1" })).toBeNull();
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
