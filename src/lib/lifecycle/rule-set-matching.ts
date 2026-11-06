/**
 * Whether a rule set save changes what the rule set matches — the test behind
 * `RuleSet.actionsHeldSince` (see the PUT in `/api/lifecycle/rules/[id]`).
 *
 * The editor sends its rules and servers with every save, changed or not, so
 * the route compares them with what is stored rather than trusting their
 * presence. Erring toward "changed" only holds actions until the next
 * detection run; erring the other way leaves an action armed under rules that
 * no longer select its item, so anything not provably equal counts as a change.
 */

/**
 * The value with every object's keys in one order and `undefined` members
 * dropped, as JSON. Postgres' jsonb reorders object keys, so the rules a save
 * sends never come back from the database in the order they went in.
 */
function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .filter((k) => obj[k] !== undefined)
          .map((k) => [k, canonical(obj[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(canonical(value)) ?? "";
}

/** Whether `next` rules differ from the `stored` ones (rule and group order counts). */
export function rulesChanged(stored: unknown, next: unknown): boolean {
  return canonicalJson(stored) !== canonicalJson(next);
}

/** Whether `next` names a different set of servers than `stored` (order aside). */
export function serverIdsChanged(stored: readonly string[], next: readonly string[]): boolean {
  const a = [...new Set(stored)].sort();
  const b = [...new Set(next)].sort();
  return a.length !== b.length || a.some((id, i) => id !== b[i]);
}

/**
 * Whether a save lets stored matches run that detection has not re-checked,
 * though the rules stay the same: turning sticky matches off (the matches the
 * rules no longer select were kept only because the rule set was sticky, and
 * their pending actions would run before detection drops them), or enabling a
 * disabled rule set (detection skipped it while disabled, so its matches are
 * as old as the day it was turned off, and Execute acts on stored matches).
 * Such a save holds the rule set's actions as a change of rules does — the
 * PUT stamps `actionsHeldSince` — and the editor offers "Save and re-detect"
 * for it. Fields left out of `next` are not changing.
 */
export function releasesStoredMatches(
  stored: { stickyMatches: boolean; enabled: boolean },
  next: { stickyMatches?: boolean; enabled?: boolean },
): boolean {
  return (stored.stickyMatches && next.stickyMatches === false) || (!stored.enabled && next.enabled === true);
}

// ─── The rule set a run read ─────────────────────────────────────────────

/**
 * The rule set columns a detection run's matches, and the actions scheduled
 * or run from them, depend on: what it matches (rules, scope, servers, the
 * Arr instance its Arr criteria are read from, whether it is enabled, sticky
 * matches) and its action (which also decides how matches fold). Its name,
 * collection, notifications and hold stamp are left out: changing them
 * changes neither.
 */
export const RULE_SET_VERSION_SELECT = {
  rules: true,
  seriesScope: true,
  serverIds: true,
  arrInstanceId: true,
  enabled: true,
  stickyMatches: true,
  actionEnabled: true,
  actionType: true,
  actionDelayDays: true,
  targetQualityProfileId: true,
  addImportExclusion: true,
  searchAfterAction: true,
  addArrTags: true,
  removeArrTags: true,
} as const;

/** A rule set row as far as `ruleSetVersion` reads it. */
export interface RuleSetVersionFields {
  rules: unknown;
  seriesScope: boolean;
  serverIds: readonly string[];
  arrInstanceId: string | null;
  enabled: boolean;
  stickyMatches: boolean;
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  targetQualityProfileId: number | null;
  addImportExclusion: boolean;
  searchAfterAction: boolean;
  addArrTags: readonly string[];
  removeArrTags: readonly string[];
}

/**
 * The version of a rule set as a run read it: equal for two reads exactly
 * when everything its matches and actions depend on is the same
 * (`RULE_SET_VERSION_SELECT`; the rules compared as `rulesChanged` compares
 * them, the servers and tags as sets).
 *
 * Nothing serialises detection or execution against a save, or one detection
 * run against another, so each step that writes matches, schedules actions or
 * acts checks the version it read against the row's: detection writes its
 * matches, releases the edit hold and schedules its actions only while the
 * rule set is still at the version it evaluated (`lockRuleSetAtVersion`),
 * and an execution acts only while the rule set is still at the version it
 * judged the action under. A run whose version is gone leaves its result for
 * the next run, which reads the current rules.
 */
export function ruleSetVersion(rs: RuleSetVersionFields): string {
  const set = (ids: readonly string[]) => [...new Set(ids)].sort();
  return canonicalJson({
    rules: rs.rules,
    seriesScope: rs.seriesScope,
    serverIds: set(rs.serverIds),
    arrInstanceId: rs.arrInstanceId,
    enabled: rs.enabled,
    stickyMatches: rs.stickyMatches,
    actionEnabled: rs.actionEnabled,
    actionType: rs.actionType,
    actionDelayDays: rs.actionDelayDays,
    targetQualityProfileId: rs.targetQualityProfileId,
    addImportExclusion: rs.addImportExclusion,
    searchAfterAction: rs.searchAfterAction,
    addArrTags: set(rs.addArrTags),
    removeArrTags: set(rs.removeArrTags),
  });
}

/** The transaction client `lockRuleSetAtVersion` locks and reads through (a Prisma transaction client). */
interface RuleSetLockClient {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => PromiseLike<unknown>;
  ruleSet: {
    findUnique: (args: { where: { id: string }; select: typeof RULE_SET_VERSION_SELECT }) => PromiseLike<RuleSetVersionFields | null>;
  };
}

/**
 * Locks the rule set's row for the rest of the transaction `tx` and answers
 * whether it is still at `version` — false when a save changed it, or it was
 * deleted, since it was read. The row lock holds a concurrent save back until
 * the transaction ends (the save's own UPDATE waits for it), so what `tx`
 * writes after a `true` answer was decided under that version, and a save
 * arriving meanwhile is applied after it — holding the actions it wrote, as
 * any save that changes the rules does.
 */
export async function lockRuleSetAtVersion(tx: RuleSetLockClient, id: string, version: string): Promise<boolean> {
  await tx.$queryRawUnsafe(`SELECT "id" FROM "RuleSet" WHERE "id" = $1 FOR UPDATE`, id);
  const row = await tx.ruleSet.findUnique({ where: { id }, select: RULE_SET_VERSION_SELECT });
  return !!row && ruleSetVersion(row) === version;
}
