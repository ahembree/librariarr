/**
 * Shared cross-server dedup types.
 *
 * Production dedup runs off the persisted `dedupKey` column (see
 * `compute-dedup-key.ts`) plus the `server-presence.ts` / `recompute-canonical.ts`
 * helpers. This module exposes the `ServerPresence` shape those helpers and the
 * grouped media routes share, and re-exports `normalizeTitle` for convenience.
 */

export interface ServerPresence {
  serverId: string;
  serverName: string;
  serverType: string;
  mediaItemId: string;
}

export { normalizeTitle } from "./compute-dedup-key";
