/** Shared constants for the browser E2E suite. */

export const ADMIN = {
  username: "e2eadmin",
  password: "e2e-password-123",
} as const;

export const AUTH_STATE = "e2e/.auth/admin.json";

/**
 * Every authenticated page and the heading text each should render. Detail
 * routes (e.g. /library/movies/[id]) need a real id and are exercised by the
 * seeded-data spec instead.
 */
export const PAGES: { path: string; heading: RegExp }[] = [
  // The dashboard h1 is a time-based greeting, not the word "Dashboard".
  { path: "/", heading: /good (morning|afternoon|evening)/i },

  // Library — top-level views.
  { path: "/library/movies", heading: /Movies/i },
  { path: "/library/series", heading: /Series/i },
  { path: "/library/music", heading: /Music/i },
  { path: "/library/history", heading: /History/i },
  { path: "/library/query", heading: /Query/i },

  // Library — series sub-views (share the "Series" h1).
  { path: "/library/series/seasons", heading: /Series/i },
  { path: "/library/series/episodes", heading: /Series/i },

  // Library — music sub-views (share the "Music" h1).
  { path: "/library/music/albums", heading: /Music/i },
  { path: "/library/music/tracks", heading: /Music/i },

  // Lifecycle.
  { path: "/lifecycle/rules", heading: /Lifecycle Rules/i },
  { path: "/lifecycle/matches", heading: /Rule Matches/i },
  { path: "/lifecycle/pending", heading: /Pending Actions/i },
  { path: "/lifecycle/exceptions", heading: /Exceptions/i },

  // Tools.
  { path: "/tools/streams", heading: /Stream Manager/i },
  { path: "/tools/preroll", heading: /Preroll Manager/i },

  // System.
  { path: "/system/logs", heading: /^Logs$/i },
  { path: "/settings", heading: /Settings/i },
];

/**
 * The sidebar navigation, grouped exactly as `buildNavigation` renders it for
 * an admin whose library types are all present (the default before any sync).
 * Used to assert every nav link is present and routes to the right place.
 */
export const NAV_LINKS: { name: RegExp; path: string }[] = [
  { name: /^Dashboard$/i, path: "/" },
  { name: /^Movies$/i, path: "/library/movies" },
  { name: /^Series$/i, path: "/library/series" },
  { name: /^Music$/i, path: "/library/music" },
  { name: /^History$/i, path: "/library/history" },
  { name: /^Query$/i, path: "/library/query" },
  { name: /^Rules$/i, path: "/lifecycle/rules" },
  { name: /^Rule Matches$/i, path: "/lifecycle/matches" },
  { name: /^Pending Actions$/i, path: "/lifecycle/pending" },
  { name: /^Exceptions$/i, path: "/lifecycle/exceptions" },
  { name: /^Streams$/i, path: "/tools/streams" },
  { name: /^Prerolls$/i, path: "/tools/preroll" },
  { name: /^Settings$/i, path: "/settings" },
  { name: /^Logs$/i, path: "/system/logs" },
];

/** The Settings tabs (role="tab") and the section heading each panel shows. */
export const SETTINGS_TABS: { tab: RegExp; heading: RegExp }[] = [
  { tab: /^General$/i, heading: /^General$/i },
  { tab: /^Scheduling$/i, heading: /^Scheduling$/i },
  { tab: /^Media Servers$/i, heading: /^Media Servers$/i },
  { tab: /^Integrations$/i, heading: /^Integrations$/i },
  { tab: /^Notifications$/i, heading: /^Notifications$/i },
  { tab: /^Authentication$/i, heading: /^Authentication$/i },
  { tab: /^System$/i, heading: /^System$/i },
];
