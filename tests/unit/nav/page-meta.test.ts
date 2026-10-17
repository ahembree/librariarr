import { describe, it, expect } from "vitest";
import { getPageMeta } from "@/lib/nav/page-meta";

describe("getPageMeta", () => {
  it("maps the root to the Dashboard", () => {
    expect(getPageMeta("/")).toEqual({ group: "Overview", title: "Dashboard" });
    expect(getPageMeta("")).toEqual({ group: "Overview", title: "Dashboard" });
  });

  it("maps top-level section routes", () => {
    expect(getPageMeta("/library/movies")).toEqual({ group: "Library", title: "Movies" });
    expect(getPageMeta("/lifecycle/rules")).toEqual({ group: "Lifecycle", title: "Rules" });
    expect(getPageMeta("/lifecycle/matches")).toEqual({ group: "Lifecycle", title: "Rule Matches" });
    expect(getPageMeta("/tools/preroll")).toEqual({ group: "Tools", title: "Prerolls" });
    expect(getPageMeta("/settings")).toEqual({ group: "System", title: "Settings" });
    expect(getPageMeta("/system/logs")).toEqual({ group: "System", title: "Logs" });
  });

  it("inherits section metadata for sub-routes and detail views", () => {
    expect(getPageMeta("/library/movies/abc123")).toEqual({ group: "Library", title: "Movies" });
    expect(getPageMeta("/library/series/show/xyz")).toEqual({ group: "Library", title: "Series" });
    expect(getPageMeta("/lifecycle/pending/deep/nested")).toEqual({
      group: "Lifecycle",
      title: "Pending Actions",
    });
  });

  it("ignores a trailing slash", () => {
    expect(getPageMeta("/library/music/")).toEqual({ group: "Library", title: "Music" });
  });

  it("matches whole path segments, so a longer sibling name does not inherit a section", () => {
    expect(getPageMeta("/library/query")).toEqual({ group: "Library", title: "Query" });
    // "/library/movies-archive" starts with "/library/movies" but is not under it.
    expect(getPageMeta("/library/movies-archive")).toEqual({ group: "Librariarr", title: "Movies archive" });
  });

  it("falls back to a title-cased last segment for unknown routes", () => {
    expect(getPageMeta("/something/new-thing")).toEqual({
      group: "Librariarr",
      title: "New thing",
    });
  });
});
