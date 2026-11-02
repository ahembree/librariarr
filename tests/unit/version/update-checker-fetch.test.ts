import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  checkForUpdate,
  fetchChangelog,
  fetchReleaseNotes,
  deduplicateReleaseBody,
  resetVersionLookups,
} from "@/lib/version/update-checker";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Let a background refresh's callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("update-checker fetch behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear stored lookups so checkForUpdate/fetchChangelog don't bleed between tests.
    resetVersionLookups();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.2.0");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetVersionLookups();
  });

  describe("checkForUpdate", () => {
    it("returns a no-op result when the version is unknown (no fetch)", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "unknown");
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
          html_url: "https://github.com/ahembree/librariarr/releases/tag/v1.3.0",
          name: "Release 1.3.0",
        }),
      );

      const result = await checkForUpdate();

      expect(result.currentVersion).toBe("1.2.0");
      expect(result.latestVersion).toBe("1.3.0");
      expect(result.updateAvailable).toBe(true);
      expect(result.releaseUrl).toBe(
        "https://github.com/ahembree/librariarr/releases/tag/v1.3.0",
      );
      expect(result.releaseName).toBe("Release 1.3.0");
      // The latest release, asked for as the app itself.
      expect(fetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/ahembree/librariarr/releases/latest",
        expect.objectContaining({
          headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Librariarr/1.2.0" },
        }),
      );
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

    it("shares one GitHub request between concurrent first lookups", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ tag_name: "v1.3.0", html_url: "u", name: "n" }),
      );

      const [a, b] = await Promise.all([checkForUpdate(), checkForUpdate()]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(a.latestVersion).toBe("1.3.0");
      expect(b).toEqual(a);
    });

    it("answers from the last lookup once it is stale and refreshes in the background", async () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ tag_name: "v1.3.0", html_url: "u", name: "n" }),
      );
      await checkForUpdate();

      vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
      let resolveGitHub!: (r: Response) => void;
      fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolveGitHub = r; }));

      // GitHub has not answered the refresh, yet the caller is not kept waiting.
      const stale = await checkForUpdate();
      expect(stale.latestVersion).toBe("1.3.0");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      resolveGitHub(jsonResponse({ tag_name: "v1.4.0", html_url: "u", name: "n" }));
      await vi.waitFor(async () => {
        expect((await checkForUpdate()).latestVersion).toBe("1.4.0");
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps the last good answer when a refresh fails", async () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ tag_name: "v1.3.0", html_url: "u", name: "n" }),
      );
      await checkForUpdate();

      vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
      fetchMock.mockResolvedValueOnce(jsonResponse(null, false, 403));
      await checkForUpdate();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await settle();

      const after = await checkForUpdate();
      expect(after.latestVersion).toBe("1.3.0");
      expect(after.updateAvailable).toBe(true);

      // The failed attempt counts as a lookup: no retry until the next hour.
      vi.setSystemTime(new Date("2026-01-01T01:59:00Z"));
      await checkForUpdate();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.setSystemTime(new Date("2026-01-01T02:00:02Z"));
      fetchMock.mockResolvedValueOnce(jsonResponse({ tag_name: "v1.3.0", html_url: "u", name: "n" }));
      await checkForUpdate();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries within minutes while GitHub has never answered", async () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN api.github.com"));

      const first = await checkForUpdate();
      expect(first.latestVersion).toBeNull();

      vi.setSystemTime(new Date("2026-01-01T00:04:00Z"));
      await checkForUpdate();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-01-01T00:05:01Z"));
      fetchMock.mockResolvedValueOnce(jsonResponse({ tag_name: "v1.3.0", html_url: "u", name: "n" }));
      await checkForUpdate();
      await vi.waitFor(async () => {
        expect((await checkForUpdate()).latestVersion).toBe("1.3.0");
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("gives up on a response whose body stalls, so later lookups are not stuck behind it", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
        const signal = (init as RequestInit).signal!;
        return {
          ok: true,
          status: 200,
          // Headers arrived; the body never does unless the request is aborted.
          json: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        } as unknown as Response;
      });

      const pending = checkForUpdate();
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.latestVersion).toBeNull();
    });
  });

  describe("fetchChangelog", () => {
    it("returns an empty array when the version is unknown (no fetch)", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "unknown");
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
      expect(notes.map((n) => n.isLatest)).toEqual([true, false, false]);
      // 1.2.0 equals current
      expect(notes.map((n) => n.isCurrent)).toEqual([false, true, false]);
      expect(notes[0]).toEqual({
        version: "1.3.0",
        name: "1.3.0",
        body: "new",
        url: "u3",
        publishedAt: "2024-03-01T00:00:00Z",
        isCurrent: false,
        isLatest: true,
      });
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
      // The ten newest, newest first.
      expect(notes.map((n) => n.version)).toEqual(
        Array.from({ length: 10 }, (_, i) => `1.${24 - i}.0`),
      );
    });

    it("gives the What's new dialog every release from the same single lookup", async () => {
      const releases = Array.from({ length: 25 }, (_, i) => ({
        tag_name: `v1.${i}.0`,
        name: `1.${i}.0`,
        body: "b",
        html_url: "u",
        published_at: "2024-01-01T00:00:00Z",
      }));
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(releases));

      const all = await fetchReleaseNotes();
      expect(all).toHaveLength(25);
      expect(all[0].version).toBe("1.24.0");
      expect(all[24].version).toBe("1.0.0");
      expect(await fetchChangelog()).toHaveLength(10);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("per_page=100");
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

    it("keeps the last release notes when a refresh fails", async () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ tag_name: "v1.3.0", name: "1.3.0", body: "b", html_url: "u" }]),
      );
      await fetchChangelog();

      vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
      fetchMock.mockRejectedValueOnce(new Error("boom"));
      await fetchChangelog();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      const notes = await fetchChangelog();
      expect(notes.map((n) => n.version)).toEqual(["1.3.0"]);
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
      expect(notes[0].body).toBe("* fix bug (12c2d85)\n* other change");
    });
  });

  describe("deduplicateReleaseBody", () => {
    it("removes duplicate list lines differing only by short hash", () => {
      const body = "* fix thing (12c2d85)\n* fix thing (deadbee)";
      const result = deduplicateReleaseBody(body);
      // The first occurrence is the one kept.
      expect(result).toBe("* fix thing (12c2d85)");
    });

    it("removes duplicates with markdown-linked hash format", () => {
      const body =
        "* fix thing ([12c2d85](https://github.com/x/y/commit/12c2d85))\n" +
        "* fix thing ([deadbee](https://github.com/x/y/commit/deadbee))";
      const result = deduplicateReleaseBody(body);
      expect(result).toBe("* fix thing ([12c2d85](https://github.com/x/y/commit/12c2d85))");
    });

    it("preserves non-list lines (headers, blanks) as-is", () => {
      const body = "## Header\n\n* item a (1234567)\n* item a (89abcde)\ntrailing text";
      const result = deduplicateReleaseBody(body);
      expect(result).toBe("## Header\n\n* item a (1234567)\ntrailing text");
    });

    it("supports both * and - list markers", () => {
      const body = "- fix x (1234567)\n- fix x (89abcde)";
      const result = deduplicateReleaseBody(body);
      expect(result).toBe("- fix x (1234567)");
    });

    it("keeps distinct entries", () => {
      const body = "* fix a (1234567)\n* fix b (89abcde)";
      const result = deduplicateReleaseBody(body);
      expect(result).toBe(body);
    });
  });
});
