import { describe, it, expect } from "vitest";
import {
  formatEpisodeCode,
  formatEpisodeTitle,
  formatMediaItemTitle,
  seriesTitleOf,
} from "@/lib/media/display-title";

const pilot = { title: "Pilot", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 1 };

describe("formatEpisodeCode", () => {
  it("zero-pads season and episode", () => {
    expect(formatEpisodeCode(1, 1)).toBe("S01E01");
    expect(formatEpisodeCode(12, 104)).toBe("S12E104");
  });

  it("keeps season 0 (specials)", () => {
    expect(formatEpisodeCode(0, 3)).toBe("S00E03");
  });

  it("gives whichever half is known, or null for neither", () => {
    expect(formatEpisodeCode(2, null)).toBe("S02");
    expect(formatEpisodeCode(undefined, 7)).toBe("E07");
    expect(formatEpisodeCode(null, undefined)).toBeNull();
  });
});

describe("seriesTitleOf", () => {
  it("is the show, never the episode's own title", () => {
    expect(seriesTitleOf(pilot)).toBe("Breaking Bad");
  });

  it("falls back to the row's own title only when it names no show", () => {
    expect(seriesTitleOf({ title: "Breaking Bad", parentTitle: null })).toBe("Breaking Bad");
    expect(seriesTitleOf({ title: "Pilot", parentTitle: "  " })).toBe("Pilot");
    expect(seriesTitleOf({ title: "", parentTitle: null })).toBe("Unknown");
  });
});

describe("formatEpisodeTitle", () => {
  it("names one episode by its show and SxxExx", () => {
    expect(formatEpisodeTitle(pilot)).toBe("Breaking Bad S01E01");
  });

  it("follows the show with the episode title when the server numbered nothing", () => {
    expect(formatEpisodeTitle({ ...pilot, seasonNumber: null, episodeNumber: null })).toBe(
      "Breaking Bad — Pilot",
    );
  });

  it("is just the show when there is nothing else to tell the episode apart", () => {
    expect(formatEpisodeTitle({ title: null, parentTitle: "Breaking Bad" })).toBe("Breaking Bad");
  });

  it("keeps the code beside the episode title when no show is recorded", () => {
    expect(formatEpisodeTitle({ ...pilot, parentTitle: null })).toBe("Pilot (S01E01)");
    expect(formatEpisodeTitle({ title: null, parentTitle: null, seasonNumber: 1, episodeNumber: 2 })).toBe(
      "S01E02",
    );
    expect(formatEpisodeTitle({})).toBe("Unknown");
  });
});

describe("formatMediaItemTitle", () => {
  it("names a SERIES row (an episode) by its show and SxxExx", () => {
    expect(formatMediaItemTitle({ ...pilot, type: "SERIES" })).toBe("Breaking Bad S01E01");
  });

  it("names a movie or track by its own title", () => {
    expect(formatMediaItemTitle({ type: "MOVIE", title: "Arrival", parentTitle: null })).toBe("Arrival");
    expect(formatMediaItemTitle({ type: "MUSIC", title: "Teardrop", parentTitle: "Massive Attack" })).toBe(
      "Teardrop",
    );
  });
});
