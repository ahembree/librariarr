import { describe, it, expect } from "vitest";
import {
  RELEASE_NOTES_PAGE_SIZE,
  cleanReleaseItem,
  countReleaseItemsByKind,
  notesSinceVersion,
  parseReleaseBody,
  parseReleaseSections,
  releaseSectionKind,
  selectWhatsNew,
  splitReleaseItemScope,
} from "@/lib/version/release-notes";

const notes = ["1.4.0", "1.3.0", "1.2.1", "1.2.0", "1.1.0"].map((version) => ({ version }));

describe("notesSinceVersion", () => {
  it("returns every release after the last seen one, up to the running one", () => {
    expect(notesSinceVersion(notes, "1.2.0", "1.3.0").map((n) => n.version)).toEqual(["1.3.0", "1.2.1"]);
  });

  it("never includes a release newer than the running one", () => {
    expect(notesSinceVersion(notes, "1.3.0", "1.3.0")).toEqual([]);
  });

  it("shows only the running version when nothing was seen before", () => {
    expect(notesSinceVersion(notes, null, "1.2.1").map((n) => n.version)).toEqual(["1.2.1"]);
  });

  it("orders newest first whatever order it is given", () => {
    const shuffled = [{ version: "1.2.1" }, { version: "1.4.0" }, { version: "1.3.0" }];
    expect(notesSinceVersion(shuffled, "1.2.0", "1.4.0").map((n) => n.version)).toEqual([
      "1.4.0",
      "1.3.0",
      "1.2.1",
    ]);
  });
});

describe("parseReleaseBody", () => {
  it("groups release-please items under their headings", () => {
    const body = [
      "## [1.3.0](https://github.com/ahembree/librariarr/compare/v1.2.0...v1.3.0) (2026-10-01)",
      "",
      "### Features",
      "",
      "* **dashboard:** add tiles ([1a2b3c4](https://github.com/ahembree/librariarr/commit/1a2b3c4))",
      "",
      "### Bug Fixes",
      "",
      "* keep counts (1a2b3c4)",
      "### Empty",
    ].join("\n");
    expect(parseReleaseBody(body)).toEqual([
      { heading: "Features", items: ["dashboard: add tiles"] },
      { heading: "Bug Fixes", items: ["keep counts"] },
    ]);
  });

  it("decodes GitHub's HTML entities", () => {
    expect(cleanReleaseItem("a &gt; b &amp;&amp; c &lt; d")).toBe("a > b && c < d");
  });
});

describe("splitReleaseItemScope", () => {
  it("splits a conventional-commit scope off the message", () => {
    expect(splitReleaseItemScope("sync: keep play counts")).toEqual({ scope: "sync", text: "keep play counts" });
  });

  it("leaves an item without a scope whole", () => {
    expect(splitReleaseItemScope("keep play counts")).toEqual({ scope: null, text: "keep play counts" });
    expect(splitReleaseItemScope("ratio 1:2 fixed")).toEqual({ scope: null, text: "ratio 1:2 fixed" });
  });
});

describe("releaseSectionKind", () => {
  it("names the release-please headings", () => {
    expect(releaseSectionKind("Features")).toBe("features");
    expect(releaseSectionKind("Bug Fixes")).toBe("fixes");
    expect(releaseSectionKind("Performance Improvements")).toBe("performance");
    expect(releaseSectionKind("Miscellaneous Chores")).toBe("other");
    expect(releaseSectionKind("⚠ BREAKING CHANGES")).toBe("breaking");
  });
});

describe("parseReleaseSections", () => {
  it("tags each section and puts breaking changes first", () => {
    const body = [
      "### Features",
      "* add tiles",
      "### ⚠ BREAKING CHANGES",
      "* **api:** drop the v0 routes",
      "### Bug Fixes",
      "* keep counts",
    ].join("\n");
    expect(parseReleaseSections(body)).toEqual([
      { heading: "⚠ BREAKING CHANGES", kind: "breaking", items: ["api: drop the v0 routes"] },
      { heading: "Features", kind: "features", items: ["add tiles"] },
      { heading: "Bug Fixes", kind: "fixes", items: ["keep counts"] },
    ]);
  });
});

describe("countReleaseItemsByKind", () => {
  it("totals items per kind in display order", () => {
    const sections = parseReleaseSections(
      ["### Bug Fixes", "* a", "* b", "### Features", "* c", "### ⚠ BREAKING CHANGES", "* d"].join("\n"),
    );
    expect(countReleaseItemsByKind([...sections, ...sections])).toEqual([
      { kind: "breaking", count: 2 },
      { kind: "features", count: 2 },
      { kind: "fixes", count: 4 },
    ]);
  });
});

describe("selectWhatsNew", () => {
  const page = (versions: string[]) => versions.map((version) => ({ version }));

  it("needs the running version's own release", () => {
    const result = selectWhatsNew(page(["1.2.0", "1.1.0"]), "1.0.0", "1.3.0");
    expect(result.hasCurrent).toBe(false);
    expect(selectWhatsNew(page(["1.3.0", "1.2.0"]), "1.0.0", "1.3.0").hasCurrent).toBe(true);
  });

  it("flags releases past a full page as truncated", () => {
    const full = page(
      Array.from({ length: RELEASE_NOTES_PAGE_SIZE }, (_, i) => `2.${RELEASE_NOTES_PAGE_SIZE - i}.0`),
    );
    expect(selectWhatsNew(full, "1.0.0", `2.${RELEASE_NOTES_PAGE_SIZE}.0`).truncated).toBe(true);
    // The last version seen is on the page, so nothing since it is missing.
    expect(selectWhatsNew(full, "2.1.0", `2.${RELEASE_NOTES_PAGE_SIZE}.0`).truncated).toBe(false);
    // A short page is GitHub's whole list.
    expect(selectWhatsNew(page(["2.1.0"]), "1.0.0", "2.1.0").truncated).toBe(false);
    expect(selectWhatsNew(full, null, `2.${RELEASE_NOTES_PAGE_SIZE}.0`).truncated).toBe(false);
  });
});
