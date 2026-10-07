import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";

/**
 * A stand-in for Tracearr's `/api/v2/public/history` keyset, for integration
 * tests that need the importer's WINDOWS to mean something: a walk only sees
 * the plays its `since`/`until` admit, in the order and pages the real API
 * serves them, so a window that starts too late visibly misses a play instead
 * of a canned page handing it over regardless.
 *
 * Mirrors the documented contract: newest first (`started_at` descending, the
 * chain id breaking ties), `since` and `until` both inclusive, an opaque cursor
 * naming the last record served, and `nextCursor: null` on the last page. Only
 * the mapped server's plays are returned. `since` and `until` select a play by
 * ANY of its sessions ("plays with a session starting at or after/before this
 * instant"), while the record carries its first session's `started_at` — so a
 * resumed chain (`addResumed`) is delivered for a `since` above its
 * `started_at`.
 */

export const TRACEARR_SERVER_ID = "11111111-2222-3333-4444-555555555555";

/** A finished play of the movie with rating key "100" unless `extra` says otherwise. */
export function play(
  id: string,
  startedAt: Date | string,
  extra: Partial<TracearrHistoryRecord> = {},
): TracearrHistoryRecord {
  const at = typeof startedAt === "string" ? startedAt : startedAt.toISOString();
  return {
    id,
    reference_id: id,
    server_id: TRACEARR_SERVER_ID,
    media_type: "movie",
    rating_key: "100",
    started_at: at,
    stopped_at: at,
    state: "stopped",
    watched: true,
    user: { id: "u", server_user_id: "acct-1", username: "Walter W", thumb_url: null, avatar_url: null },
    ...extra,
  } as TracearrHistoryRecord;
}

interface PageRequest {
  cursor?: string;
  since?: Date;
  until?: Date;
  pageSize?: number;
}

function order(a: TracearrHistoryRecord, b: TracearrHistoryRecord): number {
  const byTime = Date.parse(b.started_at) - Date.parse(a.started_at);
  return byTime !== 0 ? byTime : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

export class FakeTracearrArchive {
  private plays: TracearrHistoryRecord[] = [];
  /** When a resumed chain's latest session started, by chain id. */
  private readonly lastSessionAt = new Map<string, number>();
  /** Every page request, in the order the importer made them. */
  readonly requests: PageRequest[] = [];

  add(...records: TracearrHistoryRecord[]): void {
    this.plays.push(...records);
  }

  /** A chain whose first session is its `started_at` and whose latest began at `resumedAt`. */
  addResumed(record: TracearrHistoryRecord, resumedAt: Date): void {
    this.plays.push(record);
    this.lastSessionAt.set(record.id, resumedAt.getTime());
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  page(serverId: string, options: PageRequest = {}): { records: TracearrHistoryRecord[]; nextCursor: string | null } {
    this.requests.push({ ...options });
    const { cursor, since, until, pageSize = 100 } = options;
    let rows = this.plays
      .filter((record) => record.server_id === serverId)
      .filter(
        (record) =>
          !since ||
          Math.max(Date.parse(record.started_at), this.lastSessionAt.get(record.id) ?? -Infinity) >=
            since.getTime(),
      )
      .filter((record) => !until || Date.parse(record.started_at) <= until.getTime())
      .sort(order);
    if (cursor) {
      // Strictly older than the last record served: the ones it sorts before.
      const [at, id] = JSON.parse(cursor) as [string, string];
      const boundary = { started_at: at, id } as TracearrHistoryRecord;
      rows = rows.filter((record) => order(boundary, record) < 0);
    }
    const records = rows.slice(0, pageSize);
    const last = records.at(-1);
    return {
      records,
      nextCursor: rows.length > records.length && last ? JSON.stringify([last.started_at, last.id]) : null,
    };
  }

  /** What `findOldestPlayAt` answers: the server's oldest play, or null. */
  oldest(serverId: string): Date | null {
    const times = this.plays
      .filter((record) => record.server_id === serverId)
      .map((record) => Date.parse(record.started_at));
    return times.length > 0 ? new Date(Math.min(...times)) : null;
  }
}
