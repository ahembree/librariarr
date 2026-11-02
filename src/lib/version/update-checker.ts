import { logger } from "@/lib/logger";
import { compareSemver } from "@/lib/version/semver";
import { RELEASE_NOTES_PAGE_SIZE } from "@/lib/version/release-notes";

const GITHUB_REPO = "ahembree/librariarr";
const CACHE_KEY = "version:latest";
const CHANGELOG_CACHE_KEY = "version:changelog";
const CACHE_TTL_MS = 3_600_000; // 1 hour
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * How soon a failed lookup is retried while GitHub has never answered — the
 * boot warm-up racing the network coming up, or a rate limit. Without it that
 * one failure stood for the full hour.
 */
const FIRST_LOOKUP_RETRY_MS = 5 * 60_000;

/** The last answer one GitHub lookup gave, and the refresh in flight, if any. */
interface Lookup {
  hasValue: boolean;
  value: unknown;
  /** Whether GitHub has ever answered, i.e. `value` is not the fallback. */
  answered: boolean;
  /** When the next lookup is due. */
  refreshAt: number;
  refreshing: Promise<unknown> | null;
}

// Pinned to globalThis unconditionally: the background warm-up runs from
// instrumentation, whose bundle gets its own copy of this module, so a
// module-level store (or `appCache`) there is not the one the routes read.
const globalForVersionLookups = globalThis as unknown as {
  versionLookups: Map<string, Lookup> | undefined;
};
const lookups = (globalForVersionLookups.versionLookups ??= new Map<string, Lookup>());

/**
 * Answer from the last lookup straight away and, once it is older than
 * `CACHE_TTL_MS`, refresh it in the background. Only the very first lookup
 * waits on GitHub. Every page's sidebar and the Settings page ask for these,
 * and with a plain TTL cache the first request after each hourly expiry
 * waited on GitHub — up to the 10s timeout where GitHub is slow or blocked.
 *
 * `fetchFresh` returns null when GitHub could not answer; the last good
 * answer is then kept (`fallback` stands in when there has never been one).
 * The next attempt waits another `CACHE_TTL_MS`, or `FIRST_LOOKUP_RETRY_MS`
 * while GitHub has never answered.
 */
function staleWhileRevalidate<T>(
  key: string,
  fetchFresh: () => Promise<T | null>,
  fallback: () => T,
): Promise<T> {
  let entry = lookups.get(key);
  if (!entry) {
    entry = { hasValue: false, value: undefined, answered: false, refreshAt: 0, refreshing: null };
    lookups.set(key, entry);
  }
  if (!entry.refreshing && Date.now() >= entry.refreshAt) {
    const target = entry;
    target.refreshing = fetchFresh()
      .then((fresh) => {
        if (fresh !== null) {
          target.value = fresh;
          target.answered = true;
        } else if (!target.hasValue) {
          target.value = fallback();
        }
        target.hasValue = true;
        target.refreshAt = Date.now() + (target.answered ? CACHE_TTL_MS : FIRST_LOOKUP_RETRY_MS);
        return target.value;
      })
      .finally(() => {
        target.refreshing = null;
      });
  }
  return (entry.hasValue ? Promise.resolve(entry.value) : entry.refreshing) as Promise<T>;
}

/** Forget every stored lookup. Tests only. */
export function resetVersionLookups(): void {
  lookups.clear();
}

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  checkedAt: string;
}

/**
 * Check GitHub Releases for the latest version and compare against current.
 * Answered from the last lookup, refreshed in the background hourly (see
 * `staleWhileRevalidate`). Never throws.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

  if (currentVersion === "unknown") {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseName: null,
      checkedAt: new Date().toISOString(),
    };
  }

  const unknownLatest = (): UpdateCheckResult => ({
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseName: null,
    checkedAt: new Date().toISOString(),
  });

  return staleWhileRevalidate<UpdateCheckResult>(
    CACHE_KEY,
    async () => {
      // The timeout covers reading the body too: headers followed by a stalled
      // body would otherwise hold this lookup, and every request waiting on
      // it, forever.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {

        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": `Librariarr/${currentVersion}`,
            },
            signal: controller.signal,
          },
        );


        if (!response.ok) {
          logger.debug(
            "VersionCheck",
            `GitHub API returned ${response.status}`,
          );
          return null;
        }

        const data = await response.json();
        const tagName: string = data.tag_name ?? "";
        const latestVersion = tagName.replace(/^v/, "");
        const releaseUrl: string | null = data.html_url ?? null;
        const releaseName: string | null = data.name ?? null;

        const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

        return {
          currentVersion,
          latestVersion,
          updateAvailable,
          releaseUrl,
          releaseName,
          checkedAt: new Date().toISOString(),
        };
      } catch (error) {
        logger.debug("VersionCheck", "Failed to check for updates", {
          error: String(error),
        });
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
    unknownLatest,
  );
}

// ─── Changelog / Release Notes ───

interface ReleaseNote {
  version: string;
  name: string | null;
  body: string;
  url: string;
  publishedAt: string;
  isCurrent: boolean;
  isLatest: boolean;
}

/**
 * Strip the commit hash suffix from a changelog line for dedup comparison.
 * Handles both formats:
 *   "fix failure bugs (12c2d85)" → "fix failure bugs"
 *   "fix failure bugs ([12c2d85](https://github.com/...))" → "fix failure bugs"
 */
function lineWithoutHash(line: string): string {
  return line
    .replace(/\s*\(\[?[a-f0-9]{7,40}\]?\(?[^)]*\)?\)\s*$/, "")
    .trim();
}

/**
 * Remove duplicate changelog entries that differ only in commit hash.
 * Preserves the first occurrence of each unique line.
 */
export function deduplicateReleaseBody(body: string): string {
  const lines = body.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Keep non-list lines (headers, blank lines) as-is
    if (!trimmed.startsWith("* ") && !trimmed.startsWith("- ")) {
      result.push(line);
      continue;
    }
    const normalized = lineWithoutHash(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(line);
  }

  return result.join("\n");
}

/** How many of the newest releases the Settings → System changelog lists. */
const CHANGELOG_LENGTH = 10;

/**
 * Fetch changelog/release notes from GitHub Releases.
 * Returns up to 10 release notes: any newer versions, the current version,
 * and recent prior versions. Answered from the last lookup, refreshed in the
 * background hourly (see `staleWhileRevalidate`).
 */
export async function fetchChangelog(): Promise<ReleaseNote[]> {
  return (await fetchReleaseNotes()).slice(0, CHANGELOG_LENGTH);
}

/**
 * Every published release one GitHub page returns (`RELEASE_NOTES_PAGE_SIZE`),
 * newest first. The "What's new" dialog reads this rather than the 10-note
 * changelog: an install more than 10 releases behind the latest would find
 * none of its own notes in those 10 and never see the dialog.
 */
export async function fetchReleaseNotes(): Promise<ReleaseNote[]> {
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

  if (currentVersion === "unknown") return [];

  return staleWhileRevalidate<ReleaseNote[]>(
    CHANGELOG_CACHE_KEY,
    async () => {
      // The timeout covers reading the body too: headers followed by a stalled
      // body would otherwise hold this lookup, and every request waiting on
      // it, forever.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {

        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=${RELEASE_NOTES_PAGE_SIZE}`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": `Librariarr/${currentVersion}`,
            },
            signal: controller.signal,
          },
        );


        if (!response.ok) {
          logger.debug(
            "Changelog",
            `GitHub API returned ${response.status}`,
          );
          return null;
        }

        const releases = await response.json();
        if (!Array.isArray(releases)) return null;

        const notes: ReleaseNote[] = [];

        for (const release of releases) {
          if (release.draft) continue;

          const tag: string = release.tag_name ?? "";
          const version = tag.replace(/^v/, "");
          if (!version) continue;

          const cmp = compareSemver(version, currentVersion);

          notes.push({
            version,
            name: release.name ?? null,
            body: deduplicateReleaseBody(release.body ?? ""),
            url: release.html_url ?? "",
            publishedAt: release.published_at ?? release.created_at ?? "",
            isCurrent: cmp === 0,
            isLatest: false,
          });
        }

        // Sort newest first
        notes.sort((a, b) => compareSemver(b.version, a.version));

        // Mark the latest (first after sorting)
        if (notes.length > 0) {
          notes[0].isLatest = true;
        }

        return notes;
      } catch (error) {
        logger.debug("Changelog", "Failed to fetch changelog", {
          error: String(error),
        });
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
    () => [],
  );
}

/**
 * Start the first GitHub lookups at boot, so no request waits on them.
 * Called from instrumentation; a lookup still fresh is left alone.
 */
export async function warmVersionCache(): Promise<void> {
  await Promise.all([checkForUpdate(), fetchReleaseNotes()]);
}
