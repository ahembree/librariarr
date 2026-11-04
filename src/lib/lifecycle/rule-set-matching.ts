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
