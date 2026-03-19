import { describe, it, expect } from "vitest";
import { applyCommonFilters } from "@/lib/filters/build-where";
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
  });

  describe("duration range", () => {
    it("applies duration min and max", () => {
      const where = buildWhere({ durationMin: "3600000", durationMax: "7200000" });
      expect(where.duration).toEqual({ gte: 3600000, lte: 7200000 });
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
