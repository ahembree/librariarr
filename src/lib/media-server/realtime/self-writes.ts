/**
 * Registry of the library writes librariarr has just made to a media server
 * ITSELF, so the realtime layer can tell the server's echo of those writes
 * apart from a real library change.
 *
 * Exists because of Plex collections. `lifecycle/collections.ts` writes a
 * collection after every detection run, and Plex reports that write back over
 * its notification socket exactly as it reports any other metadata edit: one
 * `timeline` entry for the collection itself plus one for EVERY member it
 * tagged — a Plex collection is a tag stored on each member item, so adding
 * 150 movies to a collection is, on the wire, 150 movies whose metadata
 * changed. The realtime manager could not tell that echo from someone editing
 * 150 movies by hand, so a manual detection run against a rule set with a
 * 150-item collection fetched all 150 items again, and past the 100-item
 * incremental limit it enqueued a whole-server sync — an off-schedule full
 * sync whose only cause was the app's own bookkeeping.
 *
 * Nothing librariarr stores changes when an item joins or leaves a collection,
 * so the echo is safe to ignore. A mark is scoped to ONE server and ONE
 * ratingKey and expires on its own, so the blast radius of a mark is bounded:
 * a real change to the same item inside the window is reconciled by the
 * scheduled full sync, and a deletion is never suppressed at all (the manager
 * exempts it — leaving a row alive for media that is gone is the worse
 * failure).
 *
 * Dependency-free on purpose: it is imported by the lifecycle layer (which
 * writes) and the realtime layer (which reads), and must not drag either
 * one's imports into the other.
 */

/**
 * How long a mark shields a ratingKey. Plex echoes a write within a second or
 * two, but a large collection sync is many sequential writes — one `move` per
 * item for action-date ordering — so the window is measured from the LAST
 * write (`collections.ts` re-marks once its writes finish) and is generous
 * enough to cover a slow server.
 */
export const SELF_WRITE_TTL_MS = 2 * 60_000;

class SelfWriteRegistry {
  /** serverId → ratingKey → epoch ms the mark expires. */
  private readonly marks = new Map<string, Map<string, number>>();

  mark(serverId: string, ratingKeys: Iterable<string>, ttlMs: number, now: number): void {
    let byKey = this.marks.get(serverId);
    if (!byKey) {
      byKey = new Map();
      this.marks.set(serverId, byKey);
    }
    // Pruning here bounds the registry to what was marked within one TTL: a
    // steady stream of marks can never grow it past the keys of the last
    // window, and a server that stops being written to is dropped by `has`.
    for (const [key, expiresAt] of byKey) {
      if (expiresAt <= now) byKey.delete(key);
    }
    const expiresAt = now + ttlMs;
    for (const key of ratingKeys) byKey.set(String(key), expiresAt);
  }

  has(serverId: string, ratingKey: string, now: number): boolean {
    const byKey = this.marks.get(serverId);
    if (!byKey) return false;
    const expiresAt = byKey.get(ratingKey);
    if (expiresAt == null) return false;
    if (expiresAt <= now) {
      byKey.delete(ratingKey);
      if (byKey.size === 0) this.marks.delete(serverId);
      return false;
    }
    return true;
  }

  clear(): void {
    this.marks.clear();
  }
}

// Singleton pinned to globalThis so Next.js dev HMR (which re-evaluates
// modules) doesn't hand the lifecycle layer and the realtime manager two
// registries that can't see each other's marks. Same pattern as `eventBus`.
const globalForSelfWrites = globalThis as unknown as {
  realtimeSelfWrites: SelfWriteRegistry | undefined;
};

const registry = globalForSelfWrites.realtimeSelfWrites ?? new SelfWriteRegistry();

if (process.env.NODE_ENV !== "production") globalForSelfWrites.realtimeSelfWrites = registry;

/**
 * Record that librariarr is about to write (or has just written) these items
 * on this server. Re-marking an already-marked key refreshes its window.
 */
export function markSelfWrites(
  serverId: string,
  ratingKeys: Iterable<string>,
  ttlMs: number = SELF_WRITE_TTL_MS,
): void {
  registry.mark(serverId, ratingKeys, ttlMs, Date.now());
}

/** True while `ratingKey` on `serverId` is inside a self-write window. */
export function isSelfWrite(serverId: string, ratingKey: string): boolean {
  return registry.has(serverId, ratingKey, Date.now());
}

/** Test-only: forget every mark. */
export function _resetSelfWritesForTesting(): void {
  registry.clear();
}
