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

/**
 * Max result rows one `POST /api/query/column-values` request may name. The
 * Query page loads every result row, so the client splits larger result sets
 * into requests of this size — one request for 150k tracks would be ~7 MB of
 * ids, near the 10 MB body limit Next.js applies to requests passing through
 * `src/proxy.ts`. Shared by the Zod schema and the client loader.
 */
export const MAX_COLUMN_VALUE_ITEMS = 50_000;
