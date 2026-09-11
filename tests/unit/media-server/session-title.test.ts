import { describe, it, expect } from "vitest";
import { formatSessionMediaTitle } from "@/lib/media-server/session-title";

describe("formatSessionMediaTitle", () => {
  it("prefixes an episode with its show", () => {
    expect(
      formatSessionMediaTitle({
        type: "episode",
        title: "Pilot",
        parentTitle: "Season 1",
        grandparentTitle: "Breaking Bad",
      })
    ).toBe("Breaking Bad · Pilot");
  });

  it("falls back to the season title when an episode has no show title", () => {
    expect(
      formatSessionMediaTitle({ type: "episode", title: "Pilot", parentTitle: "Season 1" })
    ).toBe("Season 1 · Pilot");
  });

  it("returns the bare episode title when neither parent is known", () => {
    expect(formatSessionMediaTitle({ type: "episode", title: "Pilot" })).toBe("Pilot");
  });

  it("joins artist, album and track for music", () => {
    expect(
      formatSessionMediaTitle({
        type: "track",
        title: "Teardrop",
        parentTitle: "Mezzanine",
        grandparentTitle: "Massive Attack",
      })
    ).toBe("Massive Attack · Mezzanine · Teardrop");
  });

  it("omits missing parents for a track", () => {
    expect(formatSessionMediaTitle({ type: "track", title: "Teardrop" })).toBe("Teardrop");
  });

  it("appends the year for a movie", () => {
    expect(formatSessionMediaTitle({ type: "movie", title: "Arrival", year: 2016 })).toBe(
      "Arrival (2016)"
    );
  });

  it("omits the year when the movie has none", () => {
    expect(formatSessionMediaTitle({ type: "movie", title: "Arrival" })).toBe("Arrival");
  });

  it("never renders an empty title", () => {
    expect(formatSessionMediaTitle({ type: "movie", title: "" })).toBe("Unknown");
  });
});
