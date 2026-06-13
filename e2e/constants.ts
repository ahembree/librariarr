/** Shared constants for the browser E2E suite. */

export const ADMIN = {
  username: "e2eadmin",
  password: "e2e-password-123",
} as const;

export const AUTH_STATE = "e2e/.auth/admin.json";

/** Authenticated pages and the heading text each should render. */
export const PAGES: { path: string; heading: RegExp }[] = [
  // The dashboard h1 is a time-based greeting, not the word "Dashboard".
  { path: "/", heading: /good (morning|afternoon|evening)/i },
  { path: "/library/movies", heading: /Movies/i },
  { path: "/library/series", heading: /Series/i },
  { path: "/library/music", heading: /Music/i },
  { path: "/library/history", heading: /History/i },
  { path: "/lifecycle/rules", heading: /Rules/i },
  { path: "/lifecycle/matches", heading: /Match/i },
  { path: "/lifecycle/pending", heading: /Pending/i },
  { path: "/lifecycle/exceptions", heading: /Exception/i },
  { path: "/tools/streams", heading: /Stream/i },
  { path: "/tools/preroll", heading: /Preroll/i },
  { path: "/system/logs", heading: /Log/i },
  { path: "/settings", heading: /Settings/i },
];
