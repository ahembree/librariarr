import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { columnValueOf, isColumnFieldHandled } from "@/lib/query/column-values";
import type { ArrMetadata } from "@/lib/rules/lifecycle-engine";

const ctx = { arrLoaded: false, seerrLoaded: false };

describe("columnValueOf value normalisation", () => {
  it("turns bigints into numbers and other objects into strings", () => {
    expect(columnValueOf("videoBitrate", { videoBitrate: BigInt(8000) }, ctx)).toBe(8000);
    expect(columnValueOf("studio", { studio: { toString: () => "Obj" } }, ctx)).toBe("Obj");
    expect(columnValueOf("studio", {}, ctx)).toBeNull();
    const arrMeta = { tags: [1, 2] } as unknown as ArrMetadata;
    expect(columnValueOf("arrTag", {}, { ...ctx, arrLoaded: true, arrMeta })).toEqual(["1", "2"]);
  });

  it("reads file size as a number, and null when absent", () => {
    expect(columnValueOf("fileSize", { fileSize: "1073741824" }, ctx)).toBe(1073741824);
    expect(columnValueOf("fileSize", { fileSize: null }, ctx)).toBeNull();
  });

  it("returns null for a field nothing answers", () => {
    expect(columnValueOf("notAField", { notAField: "x" }, ctx)).toBeNull();
    expect(isColumnFieldHandled("notAField")).toBe(false);
    expect(isColumnFieldHandled("arrPath")).toBe(true);
  });

  it("prefers a series aggregate's user list and defaults empty lists", () => {
    expect(columnValueOf("watchedByUser", { watchedByUsers: ["a", "b"] }, ctx)).toEqual(["a", "b"]);
    expect(columnValueOf("watchedByUser", { watchHistory: [{ serverUsername: null }, { serverUsername: "c" }, { serverUsername: "c" }] }, ctx)).toEqual(["c"]);
    expect(columnValueOf("watchedByUser", {}, ctx)).toEqual([]);
    expect(columnValueOf("genre", { genres: null }, ctx)).toEqual([]);
    expect(columnValueOf("hasExternalId", {}, ctx)).toEqual([]);
    expect(columnValueOf("audioLanguage", {}, ctx)).toEqual([]);
    expect(columnValueOf("audioLanguage", { streams: [{ streamType: 2, language: null, codec: null }] }, ctx)).toEqual([]);
  });

  it("answers cross-system fields as null without cross data", () => {
    expect(columnValueOf("serverCount", {}, ctx)).toBeNull();
    expect(columnValueOf("matchedByRuleSet", {}, ctx)).toBeNull();
    expect(columnValueOf("hasPendingAction", {}, ctx)).toBeNull();
  });
});
