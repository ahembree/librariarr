import { describe, it, expect } from "vitest";
import {
  isArrField, isSeerrField, isStreamField, isExternalField,
  RULE_FIELDS, ARR_FIELDS, SEERR_FIELDS, STREAM_FIELDS, FIELD_SECTIONS, RULE_OPERATORS,
} from "@/lib/rules/types";

describe("isArrField", () => {
  it("returns true for arr fields", () => {
    expect(isArrField("arrTag")).toBe(true);
    expect(isArrField("arrQualityProfile")).toBe(true);
    expect(isArrField("arrMonitored")).toBe(true);
    expect(isArrField("arrRating")).toBe(true);
  });

  it("returns false for non-arr fields", () => {
    expect(isArrField("playCount")).toBe(false);
    expect(isArrField("title")).toBe(false);
    expect(isArrField("fileSize")).toBe(false);
    expect(isArrField("resolution")).toBe(false);
  });
});

describe("isSeerrField", () => {
  it("returns true for seerr fields", () => {
    expect(isSeerrField("seerrRequested")).toBe(true);
    expect(isSeerrField("seerrRequestDate")).toBe(true);
    expect(isSeerrField("seerrRequestCount")).toBe(true);
    expect(isSeerrField("seerrRequestedBy")).toBe(true);
  });

  it("returns false for non-seerr fields", () => {
    expect(isSeerrField("playCount")).toBe(false);
    expect(isSeerrField("arrTag")).toBe(false);
  });
});

describe("isStreamField", () => {
  it("returns true for stream fields", () => {
    expect(isStreamField("audioLanguage")).toBe(true);
    expect(isStreamField("subtitleLanguage")).toBe(true);
    expect(isStreamField("streamAudioCodec")).toBe(true);
    expect(isStreamField("audioStreamCount")).toBe(true);
    expect(isStreamField("subtitleStreamCount")).toBe(true);
  });

  it("returns false for non-stream fields", () => {
    expect(isStreamField("audioCodec")).toBe(false);
    expect(isStreamField("title")).toBe(false);
    expect(isStreamField("arrTag")).toBe(false);
  });
});

describe("isExternalField", () => {
  it("returns true for arr and seerr fields", () => {
    expect(isExternalField("arrTag")).toBe(true);
    expect(isExternalField("seerrRequested")).toBe(true);
  });

  it("returns false for non-external fields", () => {
    expect(isExternalField("playCount")).toBe(false);
    expect(isExternalField("audioLanguage")).toBe(false);
  });
});

describe("ARR_FIELDS", () => {
  it("contains exactly 26 arr fields", () => {
    expect(ARR_FIELDS).toHaveLength(26);
    expect(ARR_FIELDS).toEqual([
      "foundInArr",
      "arrTag", "arrQualityProfile", "arrMonitored", "arrRating",
      "arrTmdbRating", "arrRtCriticRating",
      "arrDateAdded", "arrPath", "arrSizeOnDisk", "arrOriginalLanguage",
      "arrReleaseDate", "arrInCinemasDate", "arrRuntime", "arrQualityName",
      "arrQualityCutoffMet", "arrDownloadDate",
      "arrFirstAired", "arrSeasonCount", "arrEpisodeCount", "arrStatus",
      "arrEnded", "arrSeriesType", "arrHasUnaired",
      "arrMonitoredSeasonCount", "arrMonitoredEpisodeCount",
    ]);
  });
});

describe("SEERR_FIELDS", () => {
  it("contains exactly 6 seerr fields", () => {
    expect(SEERR_FIELDS).toHaveLength(6);
    expect(SEERR_FIELDS).toContain("seerrRequested");
    expect(SEERR_FIELDS).toContain("seerrDeclineDate");
  });
});

describe("STREAM_FIELDS", () => {
  it("contains exactly 5 stream fields", () => {
    expect(STREAM_FIELDS).toHaveLength(5);
    expect(STREAM_FIELDS).toContain("audioLanguage");
    expect(STREAM_FIELDS).toContain("subtitleLanguage");
    expect(STREAM_FIELDS).toContain("streamAudioCodec");
    expect(STREAM_FIELDS).toContain("audioStreamCount");
    expect(STREAM_FIELDS).toContain("subtitleStreamCount");
  });
});

describe("FIELD_SECTIONS", () => {
  it("contains all sections including streams and external", () => {
    const sectionKeys = FIELD_SECTIONS.map((s) => s.key);
    expect(sectionKeys).toContain("content");
    expect(sectionKeys).toContain("activity");
    expect(sectionKeys).toContain("video");
    expect(sectionKeys).toContain("audio");
    expect(sectionKeys).toContain("streams");
    expect(sectionKeys).toContain("file");
    expect(sectionKeys).toContain("external");
    expect(sectionKeys).toContain("arrStatus");
    expect(sectionKeys).toContain("arrMedia");
    expect(sectionKeys).toContain("arrEpisodes");
    expect(sectionKeys).toContain("seerr");
  });
});

describe("RULE_FIELDS", () => {
  it("contains all expected fields", () => {
    const fieldValues = RULE_FIELDS.map((f) => f.value);
    // Original fields
    expect(fieldValues).toContain("playCount");
    expect(fieldValues).toContain("lastPlayedAt");
    expect(fieldValues).toContain("resolution");
    expect(fieldValues).toContain("fileSize");
    expect(fieldValues).toContain("arrTag");
    // Newly added fields
    expect(fieldValues).toContain("parentTitle");
    expect(fieldValues).toContain("albumTitle");
    expect(fieldValues).toContain("genre");
    expect(fieldValues).toContain("rating");
    expect(fieldValues).toContain("audienceRating");
    expect(fieldValues).toContain("originallyAvailableAt");
    expect(fieldValues).toContain("videoBitDepth");
    expect(fieldValues).toContain("videoProfile");
    expect(fieldValues).toContain("videoFrameRate");
    expect(fieldValues).toContain("aspectRatio");
    expect(fieldValues).toContain("scanType");
    expect(fieldValues).toContain("audioSamplingRate");
    expect(fieldValues).toContain("audioBitrate");
    expect(fieldValues).toContain("audioLanguage");
    expect(fieldValues).toContain("subtitleLanguage");
    expect(fieldValues).toContain("streamAudioCodec");
    expect(fieldValues).toContain("audioStreamCount");
    expect(fieldValues).toContain("subtitleStreamCount");
    expect(fieldValues).toContain("duration");
    expect(fieldValues).toContain("hasExternalId");
  });

  it("has correct types for each field", () => {
    const playCount = RULE_FIELDS.find((f) => f.value === "playCount");
    expect(playCount?.type).toBe("number");

    const lastPlayed = RULE_FIELDS.find((f) => f.value === "lastPlayedAt");
    expect(lastPlayed?.type).toBe("date");

    const title = RULE_FIELDS.find((f) => f.value === "title");
    expect(title?.type).toBe("text");

    const genre = RULE_FIELDS.find((f) => f.value === "genre");
    expect(genre?.type).toBe("text");
    expect(genre?.section).toBe("content");

    const audioLanguage = RULE_FIELDS.find((f) => f.value === "audioLanguage");
    expect(audioLanguage?.type).toBe("text");
    expect(audioLanguage?.section).toBe("streams");

    const hasExternalId = RULE_FIELDS.find((f) => f.value === "hasExternalId");
    expect(hasExternalId?.type).toBe("text");
    expect(hasExternalId?.section).toBe("external");

    const duration = RULE_FIELDS.find((f) => f.value === "duration");
    expect(duration?.type).toBe("number");
    expect(duration?.section).toBe("file");
  });

  it("marks enumerable fields correctly", () => {
    const enumerable = RULE_FIELDS.filter((f) => f.enumerable);
    const enumerableValues = enumerable.map((f) => f.value);
    expect(enumerableValues).toContain("genre");
    expect(enumerableValues).toContain("audioLanguage");
    expect(enumerableValues).toContain("subtitleLanguage");
    expect(enumerableValues).toContain("streamAudioCodec");
    expect(enumerableValues).toContain("hasExternalId");
    // Non-enumerable fields should not be in the list
    expect(enumerableValues).not.toContain("playCount");
    expect(enumerableValues).not.toContain("duration");
  });
});

describe("RULE_OPERATORS", () => {
  it("has operators for all types", () => {
    const numberOps = RULE_OPERATORS.filter((o) => o.types.includes("number"));
    const textOps = RULE_OPERATORS.filter((o) => o.types.includes("text"));
    const dateOps = RULE_OPERATORS.filter((o) => o.types.includes("date"));

    expect(numberOps.length).toBeGreaterThan(0);
    expect(textOps.length).toBeGreaterThan(0);
    expect(dateOps.length).toBeGreaterThan(0);
  });
});
