import { describe, it, expect, vi, afterEach } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import {
  applyCommonFilters,
  applyStartsWithFilter,
  intEqualsFilter,
  INT_MAX,
  INT_MIN,
} from "@/lib/filters/build-where";
import { RESOLUTION_DB_VALUES } from "@/lib/conditions/constants";

function build(qs: string, where: Prisma.MediaItemWhereInput = {}, ...rest: unknown[]) {
  (applyCommonFilters as (...a: unknown[]) => void)(where, new URLSearchParams(qs), ...rest);
  return where as Record<string, unknown>;
}

const ALL_KNOWN = Object.values(RESOLUTION_DB_VALUES).flat();

afterEach(() => {
  vi.useRealTimers();
});

describe("intEqualsFilter", () => {
  it("passes in-range integers and refuses out-of-range ones", () => {
    expect(intEqualsFilter(5)).toBe(5);
    expect(intEqualsFilter(INT_MAX)).toBe(INT_MAX);
    expect(intEqualsFilter(INT_MAX + 1)).toEqual({ in: [] });
    expect(intEqualsFilter(INT_MIN - 1)).toEqual({ in: [] });
  });
});

describe("applyCommonFilters — existing AND", () => {
  it("keeps an existing array AND and appends to it", () => {
    const w = build("genre=Action", { AND: [{ title: "x" }] });
    expect(w.AND).toEqual([{ title: "x" }, { genres: { array_contains: "Action" } }]);
  });

  it("wraps an existing single AND object", () => {
    const w = build("genre=Action", { AND: { title: "x" } });
    expect(w.AND).toEqual([{ title: "x" }, { genres: { array_contains: "Action" } }]);
  });

  it("leaves AND untouched when nothing is added", () => {
    const w = build("", {});
    expect(w).toEqual({});
  });
});

describe("resolution", () => {
  it("multi-select without spellings ORs known labels and Other, ignoring unknown labels", () => {
    const w = build("resolution=4K|Other|Bogus");
    expect(w.AND).toEqual([
      {
        OR: [
          { resolution: { in: RESOLUTION_DB_VALUES["4K"], mode: "insensitive" } },
          { AND: [{ resolution: { not: null } }, { NOT: { resolution: { in: ALL_KNOWN, mode: "insensitive" } } }] },
        ],
      },
    ]);
  });

  it("multi-select of only unknown labels adds nothing", () => {
    expect(build("resolution=Foo|Bar").AND).toBeUndefined();
  });

  it("single Other and single raw value without spellings", () => {
    expect(build("resolution=Other").AND).toEqual([
      { resolution: { not: null } },
      { NOT: { resolution: { in: ALL_KNOWN, mode: "insensitive" } } },
    ]);
    expect(build("resolution=576").resolution).toBe("576");
    expect(build("resolution=720P").resolution).toEqual({ in: RESOLUTION_DB_VALUES["720P"], mode: "insensitive" });
  });

  it("with spellings: one clause per label, unknown labels matched as stored values", () => {
    const spellings = new Map([["480P", ["480", "576"]]]);
    expect(build("resolution=480P", {}, undefined, spellings).AND).toEqual([{ resolution: { in: ["480", "576"] } }]);
    expect(build("resolution=4K|weird", {}, undefined, spellings).AND).toEqual([
      { OR: [{ resolution: { in: [] } }, { resolution: { in: ["weird"] } }] },
    ]);
  });

  it("Other includes NULL only when asked", () => {
    const spellings = new Map([["Other", ["999"]]]);
    expect(build("resolution=Other", {}, undefined, spellings, { resolutionOtherIncludesNull: true }).AND).toEqual([
      { OR: [{ resolution: { in: ["999"] } }, { resolution: null }] },
    ]);
    expect(build("resolution=Other", {}, undefined, spellings).AND).toEqual([{ resolution: { in: ["999"] } }]);
  });
});

describe("string filters", () => {
  it("contains filters: single value sets the field, several OR into AND", () => {
    const w = build("videoCodec=h_264&studio=A|B");
    expect(w.videoCodec).toEqual({ contains: "h\\_264", mode: "insensitive" });
    expect(w.AND).toEqual([{ OR: [{ studio: { contains: "A", mode: "insensitive" } }, { studio: { contains: "B", mode: "insensitive" } }] }]);
  });

  it("exact filters: single value or `in`", () => {
    const w = build("dynamicRange=HDR10&contentRating=PG|R");
    expect(w.dynamicRange).toBe("HDR10");
    expect(w.contentRating).toEqual({ in: ["PG", "R"] });
  });

  it("parseMulti ignores an all-empty pipe list", () => {
    expect(build("container=||")).toEqual({});
  });
});

describe("integer multi-select", () => {
  it("single, several, junk and out-of-range values", () => {
    expect(build("audioChannels=6").audioChannels).toBe(6);
    expect(build("audioChannels=2|6|x").audioChannels).toEqual({ in: [2, 6] });
    expect(build("videoBitDepth=99999999999").videoBitDepth).toEqual({ in: [] });
    expect(build("audioSamplingRate=abc").audioSamplingRate).toBeUndefined();
  });
});

describe("condition filters", () => {
  it("bare numbers are equality, invalid parts are dropped", () => {
    expect(build("yearConditions=2001").year).toBe(2001);
    expect(build("yearConditions=gt:abc|xyz").year).toBeUndefined();
  });

  it("each operator maps to its Prisma comparison", () => {
    expect(build("yearConditions=gt:1").year).toEqual({ gt: 1 });
    expect(build("yearConditions=lt:1").year).toEqual({ lt: 1 });
    expect(build("yearConditions=gte:1").year).toEqual({ gte: 1 });
    expect(build("yearConditions=lte:1").year).toEqual({ lte: 1 });
    expect(build("yearConditions=eq:1").year).toBe(1);
    expect(build("yearConditions=weird:1").year).toBe(1);
  });

  it("out-of-range bounds keep their meaning", () => {
    expect(build("yearConditions=lt:3000000000").year).toEqual({ lte: INT_MAX });
    expect(build("yearConditions=gt:3000000000").year).toEqual({ in: [] });
    expect(build("yearConditions=gte:-3000000000").year).toEqual({ gte: INT_MIN });
    expect(build("yearConditions=eq:-3000000000").year).toEqual({ in: [] });
    expect(build("ratingConditions=lt:1e309").rating).toEqual({ lte: 1e308 });
  });

  it("several conditions combine with AND by default, or OR", () => {
    expect(build("playCountConditions=gte:1|lte:5").AND).toEqual([{ playCount: { gte: 1 } }, { playCount: { lte: 5 } }]);
    expect(build("audienceRatingConditions=lt:2|gt:8&audienceRatingLogic=or").AND).toEqual([
      { OR: [{ audienceRating: { lt: 2 } }, { audienceRating: { gt: 8 } }] },
    ]);
    expect(build("videoBitrateConditions=gt:100&audioBitrateConditions=lt:9").videoBitrate).toEqual({ gt: 100 });
  });
});

describe("genre", () => {
  it("each genre is required; spellings make it case-insensitive", () => {
    const spellings = new Map([["sci-fi", ["Sci-Fi", "sci-fi"]]]);
    expect(build("genre=SCI-FI|Drama", {}, spellings).AND).toEqual([
      { OR: [{ genres: { array_contains: "Sci-Fi" } }, { genres: { array_contains: "sci-fi" } }] },
      { genres: { array_contains: "Drama" } },
    ]);
  });
});

describe("ranges", () => {
  it("file size bounds, clamped, and junk skipped", () => {
    expect(build("fileSizeMin=10&fileSizeMax=20").fileSize).toEqual({ gte: 10n, lte: 20n });
    expect(build("fileSizeMax=99999999999999999999").fileSize).toEqual({ lte: 2n ** 63n - 1n });
    expect(build("fileSizeMin=-99999999999999999999").fileSize).toEqual({ gte: -(2n ** 63n) });
    expect(build("fileSizeMin=1.5&fileSizeMax=%20").fileSize).toBeUndefined();
  });

  it("duration bounds", () => {
    expect(build("durationMin=5").duration).toEqual({ gte: 5 });
    expect(build("durationMax=9999999999").duration).toEqual({ lte: INT_MAX });
    expect(build("durationMin=x").duration).toBeUndefined();
  });
});

describe("date filters", () => {
  it("days-ago windows start at UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T15:30:00Z"));
    expect(build("lastPlayedAtDays=5").lastPlayedAt).toEqual({ gte: new Date("2025-06-10T00:00:00Z") });
    expect(build("addedAtDays=1").addedAt).toEqual({ gte: new Date("2025-06-14T00:00:00Z") });
    expect(build("originallyAvailableAtDays=2").originallyAvailableAt).toEqual({ gte: new Date("2025-06-13T00:00:00Z") });
  });

  it("non-positive or junk day counts are ignored, not treated as ranges", () => {
    const w = build("lastPlayedAtDays=0&lastPlayedAtMin=2020-01-01&addedAtDays=x&originallyAvailableAtDays=-3");
    expect(w.lastPlayedAt).toBeUndefined();
    expect(w.addedAt).toBeUndefined();
    expect(w.originallyAvailableAt).toBeUndefined();
  });

  it("huge day counts clamp to the earliest storable date", () => {
    expect(build("addedAtDays=300000000").addedAt).toEqual({ gte: new Date("0001-01-01T00:00:00.000Z") });
  });

  it("min/max ranges; max is the end of its UTC day", () => {
    expect(build("lastPlayedAtMin=2024-01-01&lastPlayedAtMax=2024-01-31").lastPlayedAt).toEqual({
      gte: new Date("2024-01-01T00:00:00Z"),
      lte: new Date("2024-01-31T23:59:59.999Z"),
    });
    expect(build("addedAtMax=2024-02-01").addedAt).toEqual({ lte: new Date("2024-02-01T23:59:59.999Z") });
    expect(build("addedAtMin=2024-02-01").addedAt).toEqual({ gte: new Date("2024-02-01T00:00:00Z") });
    expect(build("originallyAvailableAtMin=1999-01-01&originallyAvailableAtMax=1999-12-31").originallyAvailableAt).toEqual({
      gte: new Date("1999-01-01T00:00:00Z"),
      lte: new Date("1999-12-31T23:59:59.999Z"),
    });
    expect(build("originallyAvailableAtMax=nope&addedAtMin=%20").originallyAvailableAt).toBeUndefined();
  });

  it("dates outside the storable range are clamped", () => {
    expect(build("addedAtMin=-200000-01-01").addedAt).toEqual({ gte: new Date("0001-01-01T00:00:00.000Z") });
  });
});

describe("isWatchlisted", () => {
  it("only true/false are honoured", () => {
    expect(build("isWatchlisted=true").isWatchlisted).toBe(true);
    expect(build("isWatchlisted=false").isWatchlisted).toBe(false);
    expect(build("isWatchlisted=yes").isWatchlisted).toBeUndefined();
  });
});

describe("stream relation filters", () => {
  it("single and multiple audio/subtitle languages and codecs, escaped", () => {
    const w = build("audioLanguage=Engl_sh&subtitleLanguage=English|French&streamAudioCodec=dts|ac3");
    expect(w.AND).toEqual([
      { streams: { some: { streamType: 2, language: { equals: "Engl\\_sh", mode: "insensitive" } } } },
      { OR: [
        { streams: { some: { streamType: 3, language: { equals: "English", mode: "insensitive" } } } },
        { streams: { some: { streamType: 3, language: { equals: "French", mode: "insensitive" } } } },
      ] },
      { OR: [
        { streams: { some: { streamType: 2, codec: { contains: "dts", mode: "insensitive" } } } },
        { streams: { some: { streamType: 2, codec: { contains: "ac3", mode: "insensitive" } } } },
      ] },
    ]);
  });

  it("multiple audio languages, single subtitle language and single codec", () => {
    const w = build("audioLanguage=A|B&subtitleLanguage=C&streamAudioCodec=%25");
    expect(w.AND).toEqual([
      { OR: [
        { streams: { some: { streamType: 2, language: { equals: "A", mode: "insensitive" } } } },
        { streams: { some: { streamType: 2, language: { equals: "B", mode: "insensitive" } } } },
      ] },
      { streams: { some: { streamType: 3, language: { equals: "C", mode: "insensitive" } } } },
      { streams: { some: { streamType: 2, codec: { contains: "\\%", mode: "insensitive" } } } },
    ]);
  });
});

describe("applyStartsWithFilter", () => {
  it("# excludes every A-Z start, preserving existing AND (array or object)", () => {
    const a: Prisma.MediaItemWhereInput = { AND: [{ year: 1 }] };
    applyStartsWithFilter(a, "title", "#");
    const andA = a.AND as Prisma.MediaItemWhereInput[];
    expect(andA[0]).toEqual({ year: 1 });
    const not = (andA[1] as { NOT: { OR: unknown[] } }).NOT.OR;
    expect(not).toHaveLength(26);
    expect(not[0]).toEqual({ title: { startsWith: "A", mode: "insensitive" } });

    const b: Prisma.MediaItemWhereInput = { AND: { year: 2 } };
    applyStartsWithFilter(b, "parentTitle", "#");
    expect((b.AND as unknown[])[0]).toEqual({ year: 2 });

    const c: Prisma.MediaItemWhereInput = {};
    applyStartsWithFilter(c, "title", "#");
    expect(c.AND as unknown[]).toHaveLength(1);
  });

  it("a letter merges with an existing field filter and escapes the prefix", () => {
    const w: Prisma.MediaItemWhereInput = { parentTitle: { not: null } };
    applyStartsWithFilter(w, "parentTitle", "B");
    expect(w.parentTitle).toEqual({ not: null, startsWith: "B", mode: "insensitive" });

    const v: Prisma.MediaItemWhereInput = { title: "exact" };
    applyStartsWithFilter(v, "title", "_");
    expect(v.title).toEqual({ startsWith: "\\_", mode: "insensitive" });
  });
});
