import { describe, it, expect, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { mediaItem: { findMany: m.findMany } } }));

import { loadMemberEpisodes } from "@/lib/lifecycle/member-episodes";

// A file delete stored against episode ep-1 of a show.
const fileDelete = (members: string[]) => ({
  actionType: "DELETE_FILES_SONARR",
  matchedMediaItemIds: members,
  mediaItem: { id: "ep-1", type: "SERIES" },
});

describe("loadMemberEpisodes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks nothing when no action acts on one other episode", async () => {
    const episodes = await loadMemberEpisodes([
      fileDelete(["ep-1"]),
      fileDelete(["ep-2", "ep-3"]),
      { ...fileDelete(["ep-2"]), actionType: "DELETE_SONARR" },
      { ...fileDelete(["ep-2"]), mediaItem: null },
    ]);
    expect(episodes).toEqual(new Map());
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("looks each episode up once, in one query", async () => {
    m.findMany.mockResolvedValue([{ id: "ep-10", title: "Fly", seasonNumber: 3, episodeNumber: 10 }]);

    const episodes = await loadMemberEpisodes([fileDelete(["ep-10"]), fileDelete(["ep-10"]), fileDelete(["gone"])]);

    expect(m.findMany).toHaveBeenCalledTimes(1);
    expect(m.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["ep-10", "gone"] } });
    expect(episodes.get("ep-10")).toEqual({ title: "Fly", seasonNumber: 3, episodeNumber: 10 });
    // A purged episode is simply absent: the action is then named by its show.
    expect(episodes.has("gone")).toBe(false);
  });
});
