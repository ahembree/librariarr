/**
 * Max media items one ad-hoc query action may target in a single request.
 *
 * This is a safety bound, not a preference. `POST /api/query/actions` runs a
 * per-item loop of external Arr API calls (delete / unmonitor / quality-change /
 * tag ops) behind a bounded request budget, so an unbounded selection could
 * drive a very long — and, for delete actions, half-applied — batch. It's
 * enforced server-side by `queryActionSchema` and surfaced pre-flight in the
 * Query workspace UI, so a large "select all" fails clearly (Run action
 * disabled + an explicit message) instead of via a generic validation toast.
 *
 * Shared by the Zod schema and the client action bar so the two can't drift.
 */
export const MAX_QUERY_ACTION_ITEMS = 1000;
