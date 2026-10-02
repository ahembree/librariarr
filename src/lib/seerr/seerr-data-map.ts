import {
  isApprovedSeerrRequest,
  seerrRequesterKey,
  SeerrRequestStatus,
  type SeerrRequest,
} from "@/lib/seerr/seerr-client";
import type { SeerrDataMap, SeerrMetadata } from "@/lib/rules/lifecycle-engine";

/** The requester name a request contributes to `SeerrMetadata.requestedBy`. */
export function seerrRequesterName(req: SeerrRequest): string {
  return seerrRequesterKey(req.requestedBy) ?? "Unknown";
}

/** The later of two ISO timestamps (null-tolerant). */
function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(tb)) return a;
  if (Number.isNaN(ta)) return b;
  return tb > ta ? b : a;
}

function mergeInto(target: SeerrMetadata, source: SeerrMetadata): void {
  target.requestCount += source.requestCount;
  for (const name of source.requestedBy) {
    if (!target.requestedBy.includes(name)) target.requestedBy.push(name);
  }
  target.requestDate = later(target.requestDate, source.requestDate);
  target.approvalDate = later(target.approvalDate, source.approvalDate);
  target.declineDate = later(target.declineDate, source.declineDate);
}

function recordFor(req: SeerrRequest): SeerrMetadata {
  return {
    requested: true,
    requestCount: 1,
    requestDate: req.createdAt || null,
    requestedBy: [seerrRequesterName(req)],
    // updatedAt is the only approval timestamp the API exposes. Status 4/5
    // (FAILED/COMPLETED) are post-approval states — Seerr moves every approved
    // request to COMPLETED once its media arrives — so gating on APPROVED alone
    // left approvalDate null for nearly every request in the library.
    approvalDate: isApprovedSeerrRequest(req.status) ? (req.updatedAt || null) : null,
    declineDate: req.status === SeerrRequestStatus.DECLINED ? (req.updatedAt || null) : null,
  };
}

/**
 * Folds Seerr requests into the `SeerrDataMap` the rule engines read, keyed
 * `TMDB:<id>` / `TVDB:<id>` (see `lookupSeerrMeta`). Shared by the lifecycle
 * and query fetchers so the two cannot drift.
 *
 * - Dates are the MOST RECENT request/approval/decline. Seerr keeps an old
 *   COMPLETED request after its media is deleted and accepts a new request for
 *   it — deleting media is exactly what lifecycle rules do — so the earliest
 *   request made re-requested media look years old and a recency rule deleted
 *   it again before the requester could watch it.
 * - One record per Seerr media, keyed by TMDB. For TV the `TVDB:` key is an
 *   alias pointing at that same record, resolved after every instance has
 *   been read: instances can disagree on whether a show has a tvdbId, and
 *   separate records per key left the TVDB one (which series lookups try
 *   first) holding only the subset of requests from instances that knew it.
 */
export class SeerrDataMapBuilder {
  private readonly records = new Map<string, SeerrMetadata>();
  private readonly tvdbAliases = new Map<string, Set<string>>();

  constructor(private readonly type: "MOVIE" | "SERIES") {}

  add(req: SeerrRequest): void {
    const tmdbId = req.media?.tmdbId;
    const tvdbId = req.media?.tvdbId;
    let key: string | null = null;
    if (tmdbId != null) key = `TMDB:${tmdbId}`;
    if (this.type === "SERIES" && tvdbId != null) {
      const tvdbKey = `TVDB:${tvdbId}`;
      if (key) {
        let aliases = this.tvdbAliases.get(tvdbKey);
        if (!aliases) {
          aliases = new Set();
          this.tvdbAliases.set(tvdbKey, aliases);
        }
        aliases.add(key);
      } else {
        key = tvdbKey;
      }
    }
    if (!key) return;

    const record = recordFor(req);
    const existing = this.records.get(key);
    if (existing) mergeInto(existing, record);
    else this.records.set(key, record);
  }

  build(): SeerrDataMap {
    const out: SeerrDataMap = Object.fromEntries(this.records);
    for (const [tvdbKey, keys] of this.tvdbAliases) {
      const parts: SeerrMetadata[] = [];
      // A TV request with no tmdbId was stored under its TVDB key directly.
      const direct = this.records.get(tvdbKey);
      if (direct) parts.push(direct);
      for (const k of keys) {
        const rec = this.records.get(k);
        if (rec) parts.push(rec);
      }
      if (parts.length === 1) {
        out[tvdbKey] = parts[0];
      } else if (parts.length > 1) {
        const merged: SeerrMetadata = {
          requested: true,
          requestCount: 0,
          requestDate: null,
          requestedBy: [],
          approvalDate: null,
          declineDate: null,
        };
        for (const p of parts) mergeInto(merged, p);
        out[tvdbKey] = merged;
      }
    }
    return out;
  }
}
