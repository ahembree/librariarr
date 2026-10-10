import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { columnValueOf, isColumnFieldHandled } from "@/lib/query/column-values";
import {
  BUILTIN_COLUMN_FIELDS,
  QUERY_COLUMN_FIELD_DEFS,
  QUERY_COLUMN_FIELDS,
  columnHeader,
  columnSortValue,
  formatColumnValue,
} from "@/lib/query/column-fields";
import { CONDITION_FIELDS, getConditionField } from "@/lib/conditions/fields";
import type { ArrMetadata } from "@/lib/rules/lifecycle-engine";

const noExternal = { arrLoaded: false, seerrLoaded: false };
const def = (f: string) => getConditionField(f)!;

describe("query criterion columns", () => {
  it("offers every query criterion as a column, except those with a fixed column", () => {
    for (const f of CONDITION_FIELDS) {
      expect(QUERY_COLUMN_FIELDS.has(f.value) || BUILTIN_COLUMN_FIELDS.has(f.value), f.value).toBe(true);
    }
    for (const f of BUILTIN_COLUMN_FIELDS) {
      expect(getConditionField(f), f).toBeDefined();
    }
  });

  it("can compute a value for every criterion column", () => {
    for (const f of QUERY_COLUMN_FIELD_DEFS) {
      expect(isColumnFieldHandled(f.value), f.value).toBe(true);
    }
  });

  it("gives Arr columns distinct headers", () => {
    const headers = QUERY_COLUMN_FIELD_DEFS.map(columnHeader);
    expect(new Set(headers).size).toBe(headers.length);
  });
});

describe("columnValueOf", () => {
  const item = {
    id: "1",
    type: "MOVIE",
    studio: "A24",
    rating: 7.5,
    isWatchlisted: true,
    addedAt: new Date("2024-01-02T00:00:00Z"),
    genres: ["Drama", "Thriller"],
    countries: ["France"],
    externalIds: [{ source: "TMDB", externalId: "603" }],
    watchHistory: [{ serverUsername: "alice" }, { serverUsername: "bob" }, { serverUsername: "alice" }],
    streams: [
      { streamType: 2, language: "English", codec: "eac3" },
      { streamType: 2, language: "Unknown", codec: "aac" },
      { streamType: 3, language: "French", codec: "srt" },
    ],
  };

  it("reads row fields, lists and streams", () => {
    expect(columnValueOf("studio", item, noExternal)).toBe("A24");
    expect(columnValueOf("rating", item, noExternal)).toBe(7.5);
    expect(columnValueOf("isWatchlisted", item, noExternal)).toBe(true);
    expect(columnValueOf("addedAt", item, noExternal)).toBe("2024-01-02T00:00:00.000Z");
    expect(columnValueOf("genre", item, noExternal)).toEqual(["Drama", "Thriller"]);
    expect(columnValueOf("country", item, noExternal)).toEqual(["France"]);
    expect(columnValueOf("hasExternalId", item, noExternal)).toEqual(["TMDB:603"]);
    expect(columnValueOf("watchedByUser", item, noExternal)).toEqual(["alice", "bob"]);
    expect(columnValueOf("audioLanguage", item, noExternal)).toEqual(["English"]);
    expect(columnValueOf("streamAudioCodec", item, noExternal)).toEqual(["eac3", "aac"]);
    expect(columnValueOf("subtitleLanguage", item, noExternal)).toEqual(["French"]);
    expect(columnValueOf("audioStreamCount", item, noExternal)).toBe(2);
    expect(columnValueOf("subtitleStreamCount", item, noExternal)).toBe(1);
  });

  it("answers Arr fields only when Arr data was loaded", () => {
    expect(columnValueOf("foundInArr", item, noExternal)).toBeNull();
    expect(columnValueOf("foundInArr", item, { ...noExternal, arrLoaded: true })).toBe(false);
    const arrMeta = { tags: ["keep"], qualityProfile: "HD", monitored: true, sizeOnDisk: 1024 } as unknown as ArrMetadata;
    const ctx = { ...noExternal, arrLoaded: true, arrMeta };
    expect(columnValueOf("foundInArr", item, ctx)).toBe(true);
    expect(columnValueOf("arrTag", item, ctx)).toEqual(["keep"]);
    expect(columnValueOf("arrQualityProfile", item, ctx)).toBe("HD");
    expect(columnValueOf("arrSizeOnDisk", item, ctx)).toBe(1024);
  });

  it("reads an unrequested item as never requested only when Seerr was read", () => {
    expect(columnValueOf("seerrRequested", item, noExternal)).toBeNull();
    expect(columnValueOf("seerrRequested", item, { ...noExternal, seerrLoaded: true })).toBe(false);
    expect(columnValueOf("seerrRequestCount", item, { ...noExternal, seerrLoaded: true })).toBe(0);
  });

  it("reads cross-system data", () => {
    const cross = { serverCount: 2, matchedRuleSets: ["Old"], hasPendingAction: true };
    expect(columnValueOf("serverCount", item, { ...noExternal, cross })).toBe(2);
    expect(columnValueOf("matchedByRuleSet", item, { ...noExternal, cross })).toEqual(["Old"]);
    expect(columnValueOf("hasPendingAction", item, { ...noExternal, cross })).toBe(true);
  });
});

describe("formatColumnValue / columnSortValue", () => {
  it("formats by type", () => {
    expect(formatColumnValue(def("studio"), null)).toBe("-");
    expect(formatColumnValue(def("genre"), [])).toBe("-");
    expect(formatColumnValue(def("genre"), ["A", "B"])).toBe("A, B");
    expect(formatColumnValue(def("isWatchlisted"), true)).toBe("Yes");
    expect(formatColumnValue(def("addedAt"), "2024-01-02T12:00:00.000Z")).toBe("Jan 2, 2024");
    expect(formatColumnValue(def("watchedEpisodePercentage"), 33.333)).toBe("33.3%");
    expect(formatColumnValue(def("arrRuntime"), 120)).toBe("120 min");
    expect(formatColumnValue(def("ratingCount"), 12345)).toBe("12,345");
  });

  it("sorts dates chronologically and nulls as null", () => {
    expect(columnSortValue(def("addedAt"), "2024-01-02T00:00:00.000Z")).toBe(Date.parse("2024-01-02T00:00:00.000Z"));
    expect(columnSortValue(def("studio"), null)).toBeNull();
    expect(columnSortValue(def("isWatchlisted"), false)).toBe(0);
    expect(columnSortValue(def("studio"), "A24")).toBe("a24");
  });
});
