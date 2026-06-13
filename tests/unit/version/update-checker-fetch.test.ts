import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  checkForUpdate,
  fetchChangelog,
  deduplicateReleaseBody,
} from "@/lib/version/update-checker";
import { appCache } from "@/lib/cache/memory-cache";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const ORIGINAL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION;

describe("update-checker fetch behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear cache so checkForUpdate/fetchChangelog don't bleed between tests.
    appCache.clear();
    vi.stubGlobal("fetch", vi.fn());
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    appCache.clear();
    if (ORIGINAL_VERSION === undefined) {
      delete process.env.NEXT_PUBLIC_APP_VERSION;
    } else {
      process.env.NEXT_PUBLIC_APP_VERSION = ORIGINAL_VERSION;
    }
  });

  describe("checkForUpdate", () => {
    it("returns a no-op result when the version is unknown (no fetch)", async () => {
      process.env.NEXT_PUBLIC_APP_VERSION = "unknown";
      const fetchMock = vi.mocked(fetch);

      const result = await checkForUpdate();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.currentVersion).toBe("unknown");
      expect(result.latestVersion).toBeNull();
      expect(result.updateAvailable).toBe(false);
      expect(result.releaseUrl).toBeNull();
      expect(result.releaseName).toBeNull();
      expect(typeof result.checkedAt).toBe("string");
    });

    it("reports updateAvailable when GitHub has a newer release", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v1.3.0",
          html_url: "https://github.com/ahembree/librariarr/releases/v1.3.0",
          name: "Release 1.3.0",
        }),
      );

      const result = await checkForUpdate();

      expect(result.currentVersion).toBe("1.2.0");
      expect(result.latestVersion).toBe("1.3.0");
      expect(result.updateAvailable).toBe(true);
      expect(result.releaseUrl).toBe(
        "https://github.com/ahembree/librariarr/releases/v1.3.0",
      );
      expect(result.releaseName).toBe("Release 1.3.0");
    });

    it("strips a leading v from the tag name", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({ tag_name: "v1.5.2", html_url: null, name: null }),
      );

      const result = await checkForUpdate();
      expect(result.latestVersion).toBe("1.5.2");
    });

    it("reports no update when GitHub release matches the current version", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({ tag_name: "v1.2.0", html_url: "u", name: "n" }),
      );

      const result = await checkForUpdate();
      expect(result.updateAvailable).toBe(false);
      expect(result.latestVersion).toBe("1.2.0");
    });

    it("reports no update when GitHub release is older than current", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({ tag_name: "v1.0.0", html_url: "u", name: "n" }),
      );

      const result = await checkForUpdate();
      expect(result.updateAvailable).toBe(false);
    });

    it("returns a safe null result on a non-OK response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(null, false, 403));

      const result = await checkForUpdate();
      expect(result.latestVersion).toBeNull();
      expect(result.updateAvailable).toBe(false);
      expect(result.releaseUrl).toBeNull();
      expect(result.currentVersion).toBe("1.2.0");
    });

    it("never throws on a network error (returns safe fallback)", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));

      const result = await checkForUpdate();
      expect(result.latestVersion).toBeNull();
      expect(result.updateAvailable).toBe(false);
      expect(result.currentVersion).toBe("1.2.0");
    });

    it("handles a malformed payload missing tag_name", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}));

      const result = await checkForUpdate();
      // empty tag → latestVersion "" → not greater than current
      expect(result.latestVersion).toBe("");
      expect(result.updateAvailable).toBe(false);
    });

    it("caches the result so a second call does not re-fetch", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ tag_name: "v1.3.0", html_url: "u", name: "n" }),
      );

      const first = await checkForUpdate();
      const second = await checkForUpdate();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });
  });

  describe("fetchChangelog", () => {
    it("returns an empty array when the version is unknown (no fetch)", async () => {
      process.env.NEXT_PUBLIC_APP_VERSION = "unknown";
      const fetchMock = vi.mocked(fetch);

      const notes = await fetchChangelog();
      expect(notes).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns release notes sorted newest-first with isLatest/isCurrent flags", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse([
          {
            tag_name: "v1.1.0",
            name: "1.1.0",
            body: "old",
            html_url: "u1",
            published_at: "2024-01-01T00:00:00Z",
          },
          {
            tag_name: "v1.3.0",
            name: "1.3.0",
            body: "new",
            html_url: "u3",
            published_at: "2024-03-01T00:00:00Z",
          },
          {
            tag_name: "v1.2.0",
            name: "1.2.0",
            body: "current",
            html_url: "u2",
            published_at: "2024-02-01T00:00:00Z",
          },
        ]),
      );

      const notes = await fetchChangelog();

      expect(notes.map((n) => n.version)).toEqual(["1.3.0", "1.2.0", "1.1.0"]);
      expect(notes[0].isLatest).toBe(true);
      expect(notes[1].isLatest).toBe(false);
      // 1.2.0 equals current
      expect(notes[1].isCurrent).toBe(true);
      expect(notes[0].isCurrent).toBe(false);
    });

    it("skips draft releases and entries with no version tag", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse([
          { tag_name: "v1.3.0", name: "1.3.0", body: "b", html_url: "u" },
          { tag_name: "v1.4.0", draft: true, body: "b", html_url: "u" },
          { tag_name: "", body: "b", html_url: "u" },
        ]),
      );

      const notes = await fetchChangelog();
      expect(notes.map((n) => n.version)).toEqual(["1.3.0"]);
    });

    it("limits the output to 10 notes", async () => {
      const releases = Array.from({ length: 25 }, (_, i) => ({
        tag_name: `v1.${i}.0`,
        name: `1.${i}.0`,
        body: "b",
        html_url: "u",
        published_at: "2024-01-01T00:00:00Z",
      }));
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(releases));

      const notes = await fetchChangelog();
      expect(notes.length).toBe(10);
    });

    it("falls back to created_at when published_at is missing and empty url default", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse([
          {
            tag_name: "v1.3.0",
            body: "b",
            created_at: "2024-05-01T00:00:00Z",
          },
        ]),
      );

      const notes = await fetchChangelog();
      expect(notes[0].publishedAt).toBe("2024-05-01T00:00:00Z");
      expect(notes[0].name).toBeNull();
      expect(notes[0].url).toBe("");
    });

    it("returns an empty array on a non-OK response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(null, false, 500));
      const notes = await fetchChangelog();
      expect(notes).toEqual([]);
    });

    it("returns an empty array when the payload is not an array", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Not Found" }));
      const notes = await fetchChangelog();
      expect(notes).toEqual([]);
    });

    it("never throws on a network error (returns empty array)", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("boom"));
      const notes = await fetchChangelog();
      expect(notes).toEqual([]);
    });

    it("deduplicates changelog body lines that differ only by commit hash", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse([
          {
            tag_name: "v1.3.0",
            name: "1.3.0",
            body: "* fix bug (12c2d85)\n* fix bug (ab12345)\n* other change",
            html_url: "u",
          },
        ]),
      );

      const notes = await fetchChangelog();
      const lines = notes[0].body.split("\n");
      const fixBugLines = lines.filter((l) => l.includes("fix bug"));
      expect(fixBugLines.length).toBe(1);
      expect(lines).toContain("* other change");
    });
  });

  describe("deduplicateReleaseBody", () => {
    it("removes duplicate list lines differing only by short hash", () => {
      const body = "* fix thing (12c2d85)\n* fix thing (deadbee)";
      const result = deduplicateReleaseBody(body);
      expect(result.split("\n").length).toBe(1);
    });

    it("removes duplicates with markdown-linked hash format", () => {
      const body =
        "* fix thing ([12c2d85](https://github.com/x/y/commit/12c2d85))\n" +
        "* fix thing ([deadbee](https://github.com/x/y/commit/deadbee))";
      const result = deduplicateReleaseBody(body);
      expect(result.split("\n").length).toBe(1);
    });

    it("preserves non-list lines (headers, blanks) as-is", () => {
      const body = "## Header\n\n* item a (1234567)\n* item a (89abcde)\ntrailing text";
      const result = deduplicateReleaseBody(body);
      const lines = result.split("\n");
      expect(lines).toContain("## Header");
      expect(lines).toContain("");
      expect(lines).toContain("trailing text");
      expect(lines.filter((l) => l.includes("item a")).length).toBe(1);
    });

    it("supports both * and - list markers", () => {
      const body = "- fix x (1234567)\n- fix x (89abcde)";
      const result = deduplicateReleaseBody(body);
      expect(result.split("\n").length).toBe(1);
    });

    it("keeps distinct entries", () => {
      const body = "* fix a (1234567)\n* fix b (89abcde)";
      const result = deduplicateReleaseBody(body);
      expect(result.split("\n").length).toBe(2);
    });
  });
});
