/**
 * User Last Played (`userLastPlayedAt`): the date a NAMED user last played an
 * item — a criterion with two inputs, the user (`Condition.user`) and the date
 * comparison (`operator` / `value`), so "alice watched it in the last 30 days"
 * is one rule rather than "alice watched it at some time" AND "someone watched
 * it in the last 30 days".
 *
 * The value is the latest `watchedAt` among that user's counted plays (the
 * caller loads `watchHistory` filtered by `COMPLETED_PLAY_FILTER`, as for
 * `watchedByUser`), compared case-insensitively on `serverUsername`. A user
 * with no dated counted play reads NULL, and the shared date semantics apply
 * (`nullValueResult`): Is Empty = the user never played it.
 *
 * Evaluated in Phase 2 only (Phase 1 returns `{}`, and
 * `hasUserLastPlayedRules` forces the in-memory pass in both engines), so the
 * two phases cannot disagree. A group record (a show, an artist) carries the
 * latest play per user across its members (`USER_LAST_PLAYED_MAP`): a group
 * value, like `lastPlayedAt`.
 *
 * Client-safe (no Prisma, no server imports).
 */

export const USER_LAST_PLAYED_FIELD = "userLastPlayedAt";

/** The group record key holding each user's latest play (lowercased username → ISO). */
export const USER_LAST_PLAYED_MAP = "userLastPlayedByUser";

/** A watch-history row as the engines load it. */
export interface UserPlayRow {
  serverUsername: string | null;
  watchedAt?: Date | string | null;
}

/** Whether a field is User Last Played. */
export function isUserLastPlayedField(field: string): boolean {
  return field === USER_LAST_PLAYED_FIELD;
}

/** The user a rule names, trimmed; "" when it names none. */
export function ruleUserOf(rule: { user?: unknown }): string {
  return typeof rule.user === "string" ? rule.user.trim() : "";
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Each user's latest dated play among `rows`, keyed by lowercased username,
 * as an ISO string. Rows without a username or a date are skipped.
 */
export function latestPlayByUser(rows: ReadonlyArray<UserPlayRow>): Record<string, string> {
  const latest = new Map<string, number>();
  for (const row of rows) {
    const name = row.serverUsername?.toLowerCase();
    if (!name) continue;
    const t = toTime(row.watchedAt);
    if (t === null) continue;
    const prev = latest.get(name);
    if (prev === undefined || t > prev) latest.set(name, t);
  }
  // fromEntries defines own keys, so even a username "__proto__" is kept.
  return Object.fromEntries([...latest].map(([name, t]) => [name, new Date(t).toISOString()]));
}

/**
 * The date `user` last played the item, as an ISO string, or null. Reads a
 * group record's `USER_LAST_PLAYED_MAP` when present, else the item's own
 * `watchHistory` rows.
 */
export function userLastPlayedOf(item: Record<string, unknown>, user: string): string | null {
  const key = user.trim().toLowerCase();
  if (!key) return null;
  const map = item[USER_LAST_PLAYED_MAP];
  if (map && typeof map === "object") {
    const value = Object.hasOwn(map, key) ? (map as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? value : null;
  }
  const rows = Array.isArray(item.watchHistory) ? (item.watchHistory as UserPlayRow[]) : [];
  let best: number | null = null;
  for (const row of rows) {
    if (row.serverUsername?.toLowerCase() !== key) continue;
    const t = toTime(row.watchedAt);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}
