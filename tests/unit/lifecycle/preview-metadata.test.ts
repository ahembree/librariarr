import { describe, it, expect, beforeEach, vi } from "vitest";

const fetchArrMetadataForPreview = vi.hoisted(() => vi.fn());
const fetchSeerrMetadataForPreview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({ fetchArrMetadataForPreview }));
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({ fetchSeerrMetadataForPreview }));

import { loadPreviewMetadata, previewMetadataPhase } from "@/lib/lifecycle/preview-metadata";

const rules = (...fields: string[]) => [
  { id: "g", condition: "AND" as const, rules: fields.map((f) => ({ id: f, field: f, operator: "equals", value: "1", condition: "AND" as const })), groups: [] },
];

describe("previewMetadataPhase", () => {
  it("is one phase for the reads the rules need, none for neither", () => {
    expect(previewMetadataPhase(rules("foundInArr", "seerrRequested"), "MOVIE")?.key).toBe("metadata");
    expect(previewMetadataPhase(rules("foundInArr"), "MOVIE")?.key).toBe("arr");
    expect(previewMetadataPhase(rules("seerrRequested"), "SERIES")?.key).toBe("seerr");
    expect(previewMetadataPhase(rules("seerrRequested"), "MUSIC")).toBeNull();
    expect(previewMetadataPhase(rules("title"), "MOVIE")).toBeNull();
  });
});

describe("loadPreviewMetadata", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts both reads at once and splits the progress between them", async () => {
    let releaseArr!: (v: unknown) => void;
    fetchArrMetadataForPreview.mockImplementation((_u, _t, report) => {
      report?.(1);
      return new Promise((r) => (releaseArr = r));
    });
    fetchSeerrMetadataForPreview.mockImplementation(async (_u, _t, report) => {
      report?.(1);
      return { s: 1 };
    });
    const fractions: number[] = [];
    const pending = loadPreviewMetadata("u1", "MOVIE", rules("arrCustomFormatScore", "seerrRequested"), "r1", (f) => fractions.push(f));
    await vi.waitFor(() => expect(fetchSeerrMetadataForPreview).toHaveBeenCalled());
    releaseArr({ a: 1 });

    expect(await pending).toEqual({ arrData: { a: 1 }, seerrData: { s: 1 } });
    expect(fetchArrMetadataForPreview).toHaveBeenCalledWith("u1", "MOVIE", expect.any(Function), "r1", { customFormatScores: true });
    expect(fractions).toEqual([0.5, 1]);
  });

  it("reads nothing the rules do not need, and never Seerr for music", async () => {
    expect(await loadPreviewMetadata("u1", "MUSIC", rules("title", "seerrRequested"), null)).toEqual({
      arrData: undefined,
      seerrData: undefined,
    });
    expect(fetchArrMetadataForPreview).not.toHaveBeenCalled();
    expect(fetchSeerrMetadataForPreview).not.toHaveBeenCalled();
  });

  it("asks for Arr data without scores unless a rule reads them", async () => {
    fetchArrMetadataForPreview.mockResolvedValue({});
    await loadPreviewMetadata("u1", "SERIES", rules("arrTag"), null);
    expect(fetchArrMetadataForPreview).toHaveBeenCalledWith("u1", "SERIES", undefined, null, { customFormatScores: false });
  });
});
