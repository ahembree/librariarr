import { describe, it, expect, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { mediaItem: { findMany: m.findMany } } }));

import { loadMemberEpisodes } from "@/lib/lifecycle/member-episodes";

describe("loadMemberEpisodes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks nothing when there is nothing to name", async () => {
    expect(await loadMemberEpisodes([null, undefined])).toEqual(new Map());
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("looks each episode up once, in one query", async () => {
    m.findMany.mockResolvedValue([{ id: "ep-10", title: "Fly", seasonNumber: 3, episodeNumber: 10 }]);

    const episodes = await loadMemberEpisodes(["ep-10", null, "ep-10", "gone"]);

    expect(m.findMany).toHaveBeenCalledTimes(1);
    expect(m.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["ep-10", "gone"] } });
    expect(episodes.get("ep-10")).toEqual({ title: "Fly", seasonNumber: 3, episodeNumber: 10 });
    // A purged episode is simply absent: the action is then named by its show.
    expect(episodes.has("gone")).toBe(false);
  });
});
