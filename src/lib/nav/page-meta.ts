/**
 * Maps an App Router pathname to its breadcrumb metadata for the topbar.
 *
 * The topbar renders a `Group › Page` breadcrumb (e.g. `Lifecycle › Rules`).
 * This mirrors the sidebar grouping in `use-sidebar-data.ts`. Sub-routes
 * (detail panels, `[id]` segments) inherit their section's metadata via
 * longest-prefix matching, so `/library/movies/abc123` still reads
 * `Library › Movies`.
 */
export interface PageMeta {
  /** Top-level nav group label, e.g. "Library". */
  group: string;
  /** Page title, e.g. "Movies". */
  title: string;
}

interface MetaEntry extends PageMeta {
  prefix: string;
}

// Ordered most-specific-first is unnecessary because we pick the longest
// matching prefix below, but keep them grouped for readability.
const ENTRIES: MetaEntry[] = [
  { prefix: "/library/movies", group: "Library", title: "Movies" },
  { prefix: "/library/series", group: "Library", title: "Series" },
  { prefix: "/library/music", group: "Library", title: "Music" },
  { prefix: "/library/history", group: "Library", title: "History" },
  { prefix: "/library/query", group: "Library", title: "Query" },
  { prefix: "/lifecycle/rules", group: "Lifecycle", title: "Rules" },
  { prefix: "/lifecycle/matches", group: "Lifecycle", title: "Rule Matches" },
  { prefix: "/lifecycle/pending", group: "Lifecycle", title: "Pending Actions" },
  { prefix: "/lifecycle/exceptions", group: "Lifecycle", title: "Exceptions" },
  { prefix: "/tools/streams", group: "Tools", title: "Streams" },
  { prefix: "/tools/preroll", group: "Tools", title: "Prerolls" },
  { prefix: "/settings", group: "System", title: "Settings" },
  { prefix: "/system/logs", group: "System", title: "Logs" },
];

const DASHBOARD: PageMeta = { group: "Overview", title: "Dashboard" };

/**
 * Resolve breadcrumb metadata for a pathname. Falls back to the Dashboard
 * for the root and to a best-effort title for unmapped routes.
 */
export function getPageMeta(pathname: string): PageMeta {
  // Normalize away any trailing slash (except the root itself).
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (path === "/" || path === "") return DASHBOARD;

  let best: MetaEntry | null = null;
  for (const entry of ENTRIES) {
    if (path === entry.prefix || path.startsWith(entry.prefix + "/")) {
      if (!best || entry.prefix.length > best.prefix.length) best = entry;
    }
  }
  if (best) return { group: best.group, title: best.title };

  // Unknown route: title-case the last segment as a graceful fallback.
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const title = last
    ? last.charAt(0).toUpperCase() + last.slice(1).replace(/-/g, " ")
    : "Librariarr";
  return { group: "Librariarr", title };
}
