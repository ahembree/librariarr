import { appCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/logger";

const GITHUB_REPO = "ahembree/librariarr";
const CACHE_KEY = "version:latest";
const CHANGELOG_CACHE_KEY = "version:changelog";
const CACHE_TTL_MS = 3_600_000; // 1 hour
/**
 * Failed GitHub reads are cached only briefly. Caching a failure for the full
 * hour meant one blip (rate limit, DNS hiccup, timeout) left the System tab
 * stuck on "Unable to load release notes" with no way to recover.
 */
const FAILURE_CACHE_TTL_MS = 60_000; // 1 minute
const REQUEST_TIMEOUT_MS = 10_000;

/** Last successful GitHub read, served as a fallback when a refresh fails. */
let lastGoodChangelog: { notes: ReleaseNote[]; fetchedAt: string } | null = null;

/** Describe a thrown fetch error in terms a user can act on. */
function describeFetchError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `Timed out contacting GitHub after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** GET a GitHub API URL with the shared timeout, headers, and no-store policy. */
async function githubFetch(url: string, version: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": `Librariarr/${version}`,
      },
      signal: controller.signal,
      // This module does its own TTL caching via appCache; opt out of the
      // framework fetch cache so the two can't disagree.
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Reset module-level state. Test-only. */
export function __resetVersionCacheState(): void {
  lastGoodChangelog = null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  checkedAt: string;
  /** Null when the check succeeded; a reason string when GitHub could not be read. */
  error?: string | null;
}

/**
 * Compare two semver strings (major.minor.patch).
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  // Strip build metadata (+...) — it does not affect precedence — then split
  // off any pre-release (-...), which does. Avoids corrupting the numeric core.
  const parse = (v: string) => {
    const withoutBuild = v.replace(/^v/, "").split("+", 1)[0];
    const [core, pre] = withoutBuild.split("-", 2);
    const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
    return { nums, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < 3; i++) {
    const va = pa.nums[i] ?? 0;
    const vb = pb.nums[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  // Same core version: a pre-release ranks below the final release (1.2.0-rc1 < 1.2.0).
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) {
    if (pa.pre < pb.pre) return -1;
    if (pa.pre > pb.pre) return 1;
  }
  return 0;
}

/**
 * Check GitHub Releases for the latest version and compare against current.
 * Results are cached for 1 hour via appCache. Never throws.
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

  const failed = (error: string): UpdateCheckResult => {
    logger.debug("VersionCheck", "Failed to check for updates", { error });
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseName: null,
      checkedAt: new Date().toISOString(),
      error,
    };
  };

  return appCache.getOrSet<UpdateCheckResult>(
    CACHE_KEY,
    async () => {
      try {
        const response = await githubFetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
          currentVersion,
        );

        if (!response.ok) {
          return failed(`GitHub API returned ${response.status}`);
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
          error: null,
        };
      } catch (error) {
        return failed(describeFetchError(error));
      }
    },
    // Retry a failed check on the next request instead of pinning it for an hour.
    (result) => (result.error ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS),
  );
}

// ─── Changelog / Release Notes ───

export interface ReleaseNote {
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

export interface ChangelogResult {
  notes: ReleaseNote[];
  /** True when notes are available to render (even if `stale`). */
  ok: boolean;
  /** True when GitHub could not be reached and a previous good copy is served. */
  stale: boolean;
  /** Null on success; a reason string when the GitHub read failed. */
  error: string | null;
  fetchedAt: string;
}

/**
 * Parse a GitHub releases payload into sorted, flagged release notes.
 * Returns up to 10 notes: any newer versions, the current version, and recent
 * prior versions.
 */
function toReleaseNotes(releases: unknown[], currentVersion: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];

  for (const entry of releases) {
    const release = entry as Record<string, unknown>;
    if (release.draft) continue;

    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const version = tag.replace(/^v/, "");
    if (!version) continue;

    notes.push({
      version,
      name: typeof release.name === "string" ? release.name : null,
      body: deduplicateReleaseBody(
        typeof release.body === "string" ? release.body : "",
      ),
      url: typeof release.html_url === "string" ? release.html_url : "",
      publishedAt:
        (typeof release.published_at === "string" ? release.published_at : null) ??
        (typeof release.created_at === "string" ? release.created_at : null) ??
        "",
      isCurrent: compareSemver(version, currentVersion) === 0,
      isLatest: false,
    });
  }

  // Sort newest first, then mark the latest
  notes.sort((a, b) => compareSemver(b.version, a.version));
  if (notes.length > 0) notes[0].isLatest = true;

  return notes.slice(0, 10);
}

/**
 * Fetch changelog/release notes from GitHub Releases.
 *
 * A successful read is cached for an hour; a failed one for a minute, so a
 * transient GitHub error clears itself instead of blanking the System tab for
 * the rest of the hour. When a refresh fails but a previous read succeeded,
 * the last good copy is served with `stale: true`.
 */
export async function fetchChangelog(): Promise<ChangelogResult> {
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

  if (currentVersion === "unknown") {
    return {
      notes: [],
      ok: false,
      stale: false,
      error: "Application version is unavailable",
      fetchedAt: new Date().toISOString(),
    };
  }

  const failed = (error: string): ChangelogResult => {
    logger.debug("Changelog", "Failed to fetch changelog", { error });
    if (lastGoodChangelog) {
      return {
        notes: lastGoodChangelog.notes,
        ok: true,
        stale: true,
        error,
        fetchedAt: lastGoodChangelog.fetchedAt,
      };
    }
    return {
      notes: [],
      ok: false,
      stale: false,
      error,
      fetchedAt: new Date().toISOString(),
    };
  };

  return appCache.getOrSet<ChangelogResult>(
    CHANGELOG_CACHE_KEY,
    async () => {
      try {
        const response = await githubFetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=25`,
          currentVersion,
        );

        if (!response.ok) {
          return failed(`GitHub API returned ${response.status}`);
        }

        const releases = await response.json();
        if (!Array.isArray(releases)) {
          return failed("Unexpected response from the GitHub API");
        }

        const notes = toReleaseNotes(releases, currentVersion);
        const fetchedAt = new Date().toISOString();
        lastGoodChangelog = { notes, fetchedAt };

        return { notes, ok: true, stale: false, error: null, fetchedAt };
      } catch (error) {
        return failed(describeFetchError(error));
      }
    },
    // Anything carrying an error (including a stale-served copy) is retried
    // shortly rather than being pinned for the full hour.
    (result) => (result.error ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS),
  );
}

/**
 * Pre-warm the version and changelog caches. Called on boot and on an interval
 * by the background scheduler, so a user request never pays the GitHub
 * round-trip itself (that request is the slowest on the Settings page, and it
 * is the one that fails when the network is slow or a proxy times out).
 */
export async function warmVersionCache(): Promise<void> {
  await Promise.all([checkForUpdate(), fetchChangelog()]);
}
