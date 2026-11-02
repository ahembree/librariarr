import { describe, it, expect, beforeEach, vi } from "vitest";

const fetchArrMetadata = vi.hoisted(() => vi.fn());
const fetchSeerrMetadataByType = vi.hoisted(() => vi.fn());

vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({ fetchArrMetadata }));
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({ fetchSeerrMetadataByType }));

import { createRunMetadata } from "@/lib/lifecycle/run-metadata";

const rule = (field: string, enabled = true) => ({
  id: field, field, operator: "equals", value: "1", condition: "AND", enabled,
});
const group = (...rules: ReturnType<typeof rule>[]) => [{ id: "g", condition: "AND", rules, groups: [] }];
const rs = (type: string, rules: unknown, arrInstanceId: string | null = null, userId = "u1") => ({
  userId, type, rules, arrInstanceId,
});

describe("createRunMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchArrMetadata.mockResolvedValue({ a: 1 });
    fetchSeerrMetadataByType.mockImplementation(async (_u: string, types: string[]) =>
      Object.fromEntries(types.map((t) => [t, { type: t }])),
    );
  });

  it("reads Arr once per type and instance, with scores only where a rule set sharing the read needs them", async () => {
    const run = createRunMetadata([
      rs("MOVIE", group(rule("foundInArr"))),
      rs("MOVIE", group(rule("arrCustomFormatScore"))),
      rs("MOVIE", group(rule("foundInArr")), "r4k"),
      rs("SERIES", group(rule("arrTag"))),
    ]);
    await Promise.all([run.arr("u1", "MOVIE", null), run.arr("u1", "MOVIE", null), run.arr("u1", "MOVIE", "r4k")]);
    await run.arr("u1", "SERIES", null);

    expect(fetchArrMetadata).toHaveBeenCalledTimes(3);
    expect(fetchArrMetadata).toHaveBeenCalledWith("u1", "MOVIE", undefined, null, { customFormatScores: true });
    expect(fetchArrMetadata).toHaveBeenCalledWith("u1", "MOVIE", undefined, "r4k", { customFormatScores: false });
    expect(fetchArrMetadata).toHaveBeenCalledWith("u1", "SERIES", undefined, null, { customFormatScores: false });
  });

  it("ignores rule sets with no active rule when planning", async () => {
    const run = createRunMetadata([
      rs("MOVIE", group(rule("arrCustomFormatScore", false))),
      rs("MOVIE", group(rule("foundInArr"))),
    ]);
    await run.arr("u1", "MOVIE", null);
    expect(fetchArrMetadata).toHaveBeenCalledWith("u1", "MOVIE", undefined, null, { customFormatScores: false });
  });

  it("walks Seerr once for every type the run needs", async () => {
    const run = createRunMetadata([
      rs("MOVIE", group(rule("seerrRequested"))),
      rs("SERIES", group(rule("seerrRequestCount"))),
      rs("MUSIC", group(rule("seerrRequested"))),
    ]);
    expect(await run.seerr("u1", "MOVIE")).toEqual({ type: "MOVIE" });
    expect(await run.seerr("u1", "SERIES")).toEqual({ type: "SERIES" });
    expect(fetchSeerrMetadataByType).toHaveBeenCalledTimes(1);
    expect(fetchSeerrMetadataByType).toHaveBeenCalledWith("u1", ["MOVIE", "SERIES"]);
  });

  it("walks for an unplanned type on its own rather than answering an empty map", async () => {
    const run = createRunMetadata([rs("MOVIE", group(rule("seerrRequested")))]);
    expect(await run.seerr("u1", "SERIES")).toEqual({ type: "SERIES" });
    expect(fetchSeerrMetadataByType).toHaveBeenCalledWith("u1", ["SERIES"]);
  });

  it("remembers a failed read, so later rule sets fail at once without asking again", async () => {
    fetchArrMetadata.mockRejectedValue(new Error("Radarr down"));
    const run = createRunMetadata([rs("MOVIE", group(rule("foundInArr")))]);
    await expect(run.arr("u1", "MOVIE", null)).rejects.toThrow("Radarr down");
    await expect(run.arr("u1", "MOVIE", null)).rejects.toThrow("Radarr down");
    expect(fetchArrMetadata).toHaveBeenCalledTimes(1);
  });

  it("plans legacy flat rule sets as the engine reads them", async () => {
    const run = createRunMetadata([rs("MOVIE", [rule("arrCustomFormatScore")])]);
    await run.arr("u1", "MOVIE", null);
    expect(fetchArrMetadata).toHaveBeenCalledWith("u1", "MOVIE", undefined, null, { customFormatScores: true });
  });
});
