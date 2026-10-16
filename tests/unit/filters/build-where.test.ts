import { describe, it, expect } from "vitest";
import { applyCommonFilters, applyStartsWithFilter } from "@/lib/filters/build-where";
import { escapeLike } from "@/lib/filters/escape-like";
import { escapeLike as reExportedEscapeLike } from "@/lib/conditions/where-builder";
import type { Prisma } from "@/generated/prisma/client";

function buildWhere(params: Record<string, string>): Prisma.MediaItemWhereInput {
  const where: Prisma.MediaItemWhereInput = {};
  applyCommonFilters(where, new URLSearchParams(params));
  return where;
}

describe("applyCommonFilters", () => {
  describe("resolution filter", () => {
    it("maps 4K to database values", () => {
      const where = buildWhere({ resolution: "4K" });
      expect(where.resolution).toEqual({ in: ["4k", "2160", "2160p"], mode: "insensitive" });
    });

    it("maps 1080P to database values", () => {
      const where = buildWhere({ resolution: "1080P" });
      expect(where.resolution).toEqual({ in: ["1080", "1080p"], mode: "insensitive" });
    });

    it("handles multi-select resolution with OR", () => {
      const where = buildWhere({ resolution: "4K|1080P" });
      expect(where.AND).toBeDefined();
      const andClauses = where.AND as Prisma.MediaItemWhereInput[];
      expect(andClauses[0]).toHaveProperty("OR");
    });

    it("handles Other resolution as NOT IN known values", () => {
      const where = buildWhere({ resolution: "Other" });
      expect(where.AND).toBeDefined();
      const andClauses = where.AND as Prisma.MediaItemWhereInput[];
      expect(andClauses.length).toBeGreaterThanOrEqual(1);
    });

    // With the stored values grouped by label (`loadResolutionSpellings`), a
    // label matches what `normalizeResolutionLabel` calls it — the label the
    // quality chips show — not only its fixed spellings.
    describe("with resolution spellings", () => {
      const spellings = new Map([
        ["480P", ["480", "576"]],
        ["1080P", ["1080", "1024"]],
        ["Other", ["", "weird"]],
      ]);
      const build = (resolution: string) => {
        const where: Prisma.MediaItemWhereInput = {};
        applyCommonFilters(where, new URLSearchParams({ resolution }), undefined, spellings);
        return where.AND as Prisma.MediaItemWhereInput[];
      };

      it("matches every stored value the label covers", () => {
        expect(build("480P")).toEqual([{ resolution: { in: ["480", "576"] } }]);
      });

      it("ORs a multi-select", () => {
        expect(build("480P|1080P")).toEqual([
          { OR: [{ resolution: { in: ["480", "576"] } }, { resolution: { in: ["1080", "1024"] } }] },
        ]);
      });

      // A movie, episode or track card shows no chip for a missing resolution,
      // so on those listings it is not Other.
      it("leaves a missing resolution out of Other by default", () => {
        expect(build("Other")).toEqual([{ resolution: { in: ["", "weird"] } }]);
      });

      it("takes a missing resolution as Other where the chips count it so", () => {
        const where: Prisma.MediaItemWhereInput = {};
        applyCommonFilters(where, new URLSearchParams({ resolution: "Other" }), undefined, spellings, {
          resolutionOtherIncludesNull: true,
        });
        expect(where.AND).toEqual([
          { OR: [{ resolution: { in: ["", "weird"] } }, { resolution: null }] },
        ]);
      });

      it("matches nothing for a label no stored value has", () => {
        expect(build("4K")).toEqual([{ resolution: { in: [] } }]);
      });

      it("matches a value that is not a label as a stored value", () => {
        expect(build("1440")).toEqual([{ resolution: { in: ["1440"] } }]);
      });
    });
  });

  describe("string contains filters", () => {
    it("applies videoCodec filter", () => {
      const where = buildWhere({ videoCodec: "h264" });
      expect(where.videoCodec).toEqual({ contains: "h264", mode: "insensitive" });
    });

    it("applies multi-select videoCodec with OR", () => {
      const where = buildWhere({ videoCodec: "h264|hevc" });
      expect(where.AND).toBeDefined();
      const andClauses = where.AND as Prisma.MediaItemWhereInput[];
      const orClause = andClauses.find((c) => "OR" in c);
      expect(orClause).toBeDefined();
    });
  });

  describe("LIKE metacharacter escaping", () => {
    // Prisma's `contains` / `startsWith` compile to LIKE without escaping,
    // so live `?search=1_ Things` matched "10 Things…" and `?search=%`
    // matched everything. The escaped value must be what reaches Prisma.
    it("escapes % _ and \\ in a single contains filter", () => {
      const where = buildWhere({ videoCodec: "h_264%\\" });
      expect(where.videoCodec).toEqual({ contains: "h\\_264\\%\\\\", mode: "insensitive" });
    });

    it("escapes every value of a multi-select contains filter", () => {
      const where = buildWhere({ videoCodec: "h_264|%" });
      const andClauses = where.AND as Prisma.MediaItemWhereInput[];
      const orClause = andClauses.find((c) => "OR" in c);
      expect(orClause).toEqual({
        OR: [
          { videoCodec: { contains: "h\\_264", mode: "insensitive" } },
          { videoCodec: { contains: "\\%", mode: "insensitive" } },
        ],
      });
    });

    it("escapes the stream audio codec contains filter", () => {
      const where = buildWhere({ streamAudioCodec: "a_c%" });
      const andClauses = where.AND as Prisma.MediaItemWhereInput[];
      expect(andClauses).toContainEqual({
        streams: { some: { streamType: 2, codec: { contains: "a\\_c\\%", mode: "insensitive" } } },
      });
    });

    it("escapes a startsWith value and leaves A-Z untouched", () => {
      const where: Prisma.MediaItemWhereInput = {};
      applyStartsWithFilter(where, "title", "%");
      expect(where.title).toEqual({ startsWith: "\\%", mode: "insensitive" });

      const letter: Prisma.MediaItemWhereInput = {};
      applyStartsWithFilter(letter, "title", "A");
      expect(letter.title).toEqual({ startsWith: "A", mode: "insensitive" });

      const merged: Prisma.MediaItemWhereInput = { parentTitle: { not: null } };
      applyStartsWithFilter(merged, "parentTitle", "_");
      expect(merged.parentTitle).toEqual({ not: null, startsWith: "\\_", mode: "insensitive" });
    });

    it("escapeLike escapes exactly the three LIKE metacharacters", () => {
      expect(escapeLike("1_ Things")).toBe("1\\_ Things");
      expect(escapeLike("%Things%Hate")).toBe("\\%Things\\%Hate");
      expect(escapeLike("a\\b")).toBe("a\\\\b");
      expect(escapeLike("plain title")).toBe("plain title");
      // The rule engine's import path is a re-export of the same function.
      expect(reExportedEscapeLike).toBe(escapeLike);
    });
  });

  describe("exact match filters", () => {
    it("applies dynamicRange filter", () => {
      const where = buildWhere({ dynamicRange: "HDR10" });
      expect(where.dynamicRange).toBe("HDR10");
    });

    it("applies multi-select dynamicRange with in", () => {
      const where = buildWhere({ dynamicRange: "HDR10|SDR" });
      expect(where.dynamicRange).toEqual({ in: ["HDR10", "SDR"] });
    });
  });

  describe("integer filters", () => {
    it("applies single audioChannels filter", () => {
      const where = buildWhere({ audioChannels: "6" });
      expect(where.audioChannels).toBe(6);
    });

    it("applies multi-select audioChannels with in", () => {
      const where = buildWhere({ audioChannels: "6|8" });
      expect(where.audioChannels).toEqual({ in: [6, 8] });
    });
  });

  describe("file size range", () => {
    it("applies min file size as BigInt", () => {
      const where = buildWhere({ fileSizeMin: "1073741824" });
      expect(where.fileSize).toEqual({ gte: BigInt("1073741824") });
    });

    it("applies max file size as BigInt", () => {
      const where = buildWhere({ fileSizeMax: "5368709120" });
      expect(where.fileSize).toEqual({ lte: BigInt("5368709120") });
    });

    it("applies both min and max file size", () => {
      const where = buildWhere({ fileSizeMin: "100", fileSizeMax: "200" });
      expect(where.fileSize).toEqual({ gte: BigInt(100), lte: BigInt(200) });
    });

    it("ignores malformed file size without throwing (BigInt() would throw)", () => {
      // Previously BigInt("abc")/BigInt("1.5") threw synchronously → unhandled 500.
      expect(() => buildWhere({ fileSizeMin: "abc" })).not.toThrow();
      expect(buildWhere({ fileSizeMin: "abc" }).fileSize).toBeUndefined();
      expect(buildWhere({ fileSizeMax: "12.5" }).fileSize).toBeUndefined();
      // A valid min alongside a malformed max keeps only the valid bound.
      expect(buildWhere({ fileSizeMin: "100", fileSizeMax: "nope" }).fileSize).toEqual({ gte: BigInt(100) });
    });
  });

  describe("duration range", () => {
    it("applies duration min and max", () => {
      const where = buildWhere({ durationMin: "3600000", durationMax: "7200000" });
      expect(where.duration).toEqual({ gte: 3600000, lte: 7200000 });
    });

    it("ignores non-numeric duration (NaN would 500 at query time)", () => {
      expect(buildWhere({ durationMin: "abc" }).duration).toBeUndefined();
    });
  });

  describe("malformed date ranges", () => {
    it("ignores invalid date range params instead of producing an Invalid Date clause", () => {
      expect(buildWhere({ lastPlayedAtMin: "not-a-date" }).lastPlayedAt).toBeUndefined();
      expect(buildWhere({ addedAtMax: "garbage" }).addedAt).toBeUndefined();
      expect(buildWhere({ originallyAvailableAtMin: "xyz" }).originallyAvailableAt).toBeUndefined();
    });
  });

  describe("condition filters", () => {
    it("applies single year condition", () => {
      const where = buildWhere({ yearConditions: "gte:2020" });
      expect(where.year).toEqual({ gte: 2020 });
    });

    it("applies multiple year conditions with AND", () => {
      const where = buildWhere({ yearConditions: "gte:2020|lte:2024", yearLogic: "and" });
      expect(where.AND).toBeDefined();
    });

    it("applies multiple year conditions with OR", () => {
      const where = buildWhere({ yearConditions: "eq:2020|eq:2024", yearLogic: "or" });
      const andClauses = where.AND as Prisma.MediaItemWhereInput[];
      const orClause = andClauses.find((c) => "OR" in c);
      expect(orClause).toBeDefined();
    });

    it("applies play count condition", () => {
      const where = buildWhere({ playCountConditions: "gt:5" });
      expect(where.playCount).toEqual({ gt: 5 });
    });
  });

  describe("genre filter", () => {
    it("applies genre array_contains", () => {
      const where = buildWhere({ genre: "Action" });
      const andClauses = where.AND as Prisma.MediaItemWhereInput[];
      expect(andClauses).toBeDefined();
      expect(andClauses[0]).toEqual({ genres: { array_contains: "Action" } });
    });

    it("applies multiple genres as AND", () => {
      const where = buildWhere({ genre: "Action|Comedy" });
      const andClauses = where.AND as Prisma.MediaItemWhereInput[];
      expect(andClauses).toHaveLength(2);
    });

    it("matches any stored spelling of a genre when given them", () => {
      // `array_contains` is case-sensitive; the dropdown offers one entry per
      // genre whatever its case, so the filter must cover every spelling.
      const where: Prisma.MediaItemWhereInput = {};
      applyCommonFilters(
        where,
        new URLSearchParams({ genre: "SCI-FI|Drama" }),
        new Map([["sci-fi", ["Sci-Fi", "sci-fi"]], ["drama", ["Drama"]]]),
      );
      expect(where.AND).toEqual([
        { OR: [{ genres: { array_contains: "Sci-Fi" } }, { genres: { array_contains: "sci-fi" } }] },
        { genres: { array_contains: "Drama" } },
      ]);
    });
  });

  describe("date filters", () => {
    it("applies lastPlayedAtDays filter", () => {
      const where = buildWhere({ lastPlayedAtDays: "30" });
      expect(where.lastPlayedAt).toBeDefined();
      expect((where.lastPlayedAt as Record<string, Date>).gte).toBeInstanceOf(Date);
    });

    it("applies addedAtDays filter", () => {
      const where = buildWhere({ addedAtDays: "7" });
      expect(where.addedAt).toBeDefined();
      expect((where.addedAt as Record<string, Date>).gte).toBeInstanceOf(Date);
    });
  });

  describe("no filters", () => {
    it("returns empty where when no params", () => {
      const where = buildWhere({});
      expect(where).toEqual({});
    });
  });
});
