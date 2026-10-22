/**
 * Client-safe helpers for GitHub release notes (release-please bodies):
 * shared by the Settings → System changelog and the "What's new" dialog.
 */

import { compareSemver } from "./semver";

/** How many releases one GitHub lookup returns (the API's per-page maximum). */
export const RELEASE_NOTES_PAGE_SIZE = 100;

/**
 * Clean a markdown list item for display:
 * - Strip commit hash links: "([abc1234](url))" or "(abc1234)"
 * - Convert bold scopes: "**lifecycle:** msg" → "lifecycle: msg"
 * - Decode HTML entities: "&gt;" → ">"
 */
export function cleanReleaseItem(raw: string): string {
  return (
    raw
      // Remove markdown commit links: ([hash](url))
      .replace(/\s*\(\[?[a-f0-9]{7,40}\]?\([^)]*\)\)/g, "")
      // Remove bare hash refs: (hash)
      .replace(/\s*\([a-f0-9]{7,40}\)/g, "")
      // Convert **scope:** to scope:
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      // Decode common HTML entities from GitHub
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

/**
 * Parse a release-please body into grouped sections.
 * Handles the format: ## [version](url) (date) then ### Section headings with * items.
 */
export function parseReleaseBody(body: string): { heading: string; items: string[] }[] {
  const lines = body.split("\n");
  const sections: { heading: string; items: string[] }[] = [];
  let current: { heading: string; items: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip the version header line: ## [0.11.3](url) (date)
    if (/^##\s+\[?\d+\.\d+/.test(trimmed)) continue;

    // Section heading (### Bug Fixes, ### Features, etc.)
    const headingMatch = trimmed.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) {
      current = { heading: headingMatch[1], items: [] };
      sections.push(current);
      continue;
    }

    // List item
    if ((trimmed.startsWith("* ") || trimmed.startsWith("- ")) && current) {
      current.items.push(cleanReleaseItem(trimmed.slice(2)));
    }
  }

  return sections.filter((s) => s.items.length > 0);
}


/**
 * The releases a "What's new" dialog shows after an upgrade: every note newer
 * than `lastSeenVersion` and no newer than `currentVersion`, newest first.
 * With no `lastSeenVersion` (an install upgraded from before the dialog
 * existed, so where it came from is unknown) only the current version's note.
 */
export function notesSinceVersion<T extends { version: string }>(
  notes: T[],
  lastSeenVersion: string | null,
  currentVersion: string,
): T[] {
  return notes
    .filter((note) => {
      if (compareSemver(note.version, currentVersion) > 0) return false;
      if (lastSeenVersion === null) return compareSemver(note.version, currentVersion) === 0;
      return compareSemver(note.version, lastSeenVersion) > 0;
    })
    .sort((a, b) => compareSemver(b.version, a.version));
}

/** A release-please item's conventional-commit scope ("sync: keep counts" → "sync"), if it has one. */
export function splitReleaseItemScope(item: string): { scope: string | null; text: string } {
  const match = item.match(/^([\w./-]{1,40}):\s+(.+)$/);
  return match ? { scope: match[1], text: match[2] } : { scope: null, text: item };
}

export type ReleaseSectionKind = "breaking" | "features" | "fixes" | "performance" | "other";

/** The kinds in the order a release lists them: breaking changes first. */
export const RELEASE_SECTION_KIND_ORDER: ReleaseSectionKind[] = [
  "breaking",
  "features",
  "fixes",
  "performance",
  "other",
];

/** Which kind of change a release-please section heading lists. */
export function releaseSectionKind(heading: string): ReleaseSectionKind {
  const h = heading.toLowerCase();
  if (h.includes("breaking")) return "breaking";
  if (h.includes("feature")) return "features";
  if (h.includes("fix")) return "fixes";
  if (h.includes("perf")) return "performance";
  return "other";
}

export interface ReleaseSection {
  heading: string;
  kind: ReleaseSectionKind;
  items: string[];
}

/**
 * A release body as its sections, each tagged with its kind, breaking changes
 * first and the rest in the order the release lists them.
 */
export function parseReleaseSections(body: string): ReleaseSection[] {
  const sections = parseReleaseBody(body).map((section) => ({
    ...section,
    kind: releaseSectionKind(section.heading),
  }));
  return [
    ...sections.filter((section) => section.kind === "breaking"),
    ...sections.filter((section) => section.kind !== "breaking"),
  ];
}

/** Item counts per kind of change, in display order, leaving out kinds with none. */
export function countReleaseItemsByKind(
  sections: ReleaseSection[],
): { kind: ReleaseSectionKind; count: number }[] {
  const counts = new Map<ReleaseSectionKind, number>();
  for (const section of sections) {
    counts.set(section.kind, (counts.get(section.kind) ?? 0) + section.items.length);
  }
  return RELEASE_SECTION_KIND_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({
    kind,
    count: counts.get(kind)!,
  }));
}

/**
 * What the "What's new" dialog shows: the notes `notesSinceVersion` picks,
 * whether the running version's own release is among them, and whether older
 * releases since `lastSeenVersion` lie past the one page GitHub returned.
 *
 * Without its own release the dialog must not open: closing it records the
 * running version as seen, so its notes — published after the cached lookup,
 * say — would never be shown.
 */
export function selectWhatsNew<T extends { version: string }>(
  allNotes: T[],
  lastSeenVersion: string | null,
  currentVersion: string,
): { notes: T[]; hasCurrent: boolean; truncated: boolean } {
  const notes = notesSinceVersion(allNotes, lastSeenVersion, currentVersion);
  const hasCurrent = notes.some((note) => compareSemver(note.version, currentVersion) === 0);
  const oldest = allNotes.reduce<T | null>(
    (min, note) => (min === null || compareSemver(note.version, min.version) < 0 ? note : min),
    null,
  );
  const truncated =
    lastSeenVersion !== null &&
    allNotes.length >= RELEASE_NOTES_PAGE_SIZE &&
    oldest !== null &&
    compareSemver(oldest.version, lastSeenVersion) > 0;
  return { notes, hasCurrent, truncated };
}
