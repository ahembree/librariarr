import { IntegrationError } from "@/lib/integration-error";
import type { SeerrClient, SeerrRequest } from "@/lib/seerr/seerr-client";

export const SEERR_REQUEST_PAGE_SIZE = 100;
// Hard ceiling so a huge or looping instance can't hang the caller.
// 1000 pages × ~90 new requests per page ≈ 90k requests.
export const SEERR_MAX_REQUEST_PAGES = 1000;
// Consecutive pages overlap by this many rows. `GET /api/v1/request` is an
// offset listing ordered newest-first, so a request created or deleted between
// two page fetches shifts every later row: a creation re-delivers a row (made
// harmless by the id dedupe), a deletion moves an unread row under an offset
// already passed. The overlap absorbs up to this many deletions per page; past
// that the walk cannot prove it read everything and throws.
const PAGE_OVERLAP = 10;

export interface WalkSeerrRequestsOptions {
  /** Instance name, for error messages. */
  instanceName: string;
  /**
   * Only hand `onRequest` requests of this type. Sent to the server as the
   * `mediaType` filter when it accepts it (Seerr, Jellyseerr ≥ 2.6.0) and
   * always re-checked client-side: Overseerr and older Jellyseerr reject the
   * parameter with a 400, and TMDB movie and TV ids share one numeric space,
   * so one TV request leaking into a movie map marks an unrelated movie
   * as requested.
   */
  mediaType?: "movie" | "tv";
  /** Reports 0..1 completion of the walk. */
  onProgress?: (fraction: number) => void;
}

/**
 * Walk every request on a Seerr instance, calling `onRequest` exactly once per
 * request id.
 *
 * Throws instead of returning a partial walk — on a fetch failure, a malformed
 * page, a listing that shifted further than the page overlap can absorb, a
 * cursor that stops advancing, or the page cap. The request list feeds rules
 * such as "Has Request = false", where a request that was never read makes
 * its media look never requested: truncation fails OPEN, so the caller must
 * learn about it rather than receive a map that silently lacks entries.
 */
export async function walkSeerrRequests(
  client: SeerrClient,
  options: WalkSeerrRequestsOptions,
  onRequest: (req: SeerrRequest) => void,
): Promise<void> {
  const { instanceName, mediaType, onProgress } = options;
  const take = SEERR_REQUEST_PAGE_SIZE;
  const seen = new Set<number>();
  let sendMediaType = mediaType !== undefined;
  let skip = 0;
  let pages = 0;

  while (true) {
    if (pages >= SEERR_MAX_REQUEST_PAGES) {
      throw new Error(
        `Seerr request list on "${instanceName}" exceeded ${SEERR_MAX_REQUEST_PAGES} pages — refusing to use a truncated request list`,
      );
    }

    let results: SeerrRequest[];
    let total: number | undefined;
    try {
      const page = await client.getRequests({
        take,
        skip,
        ...(sendMediaType ? { mediaType } : {}),
      });
      if (!page || !Array.isArray(page.results)) {
        throw new Error(
          `Seerr "${instanceName}" returned an unexpected response for its request list`,
        );
      }
      results = page.results;
      total = page.pageInfo?.results;
    } catch (error) {
      // Overseerr and Jellyseerr before 2.6.0 answer the unknown `mediaType`
      // query parameter with a 400 — fall back to filtering client-side.
      if (
        sendMediaType &&
        pages === 0 &&
        error instanceof IntegrationError &&
        error.status === 400
      ) {
        sendMediaType = false;
        continue;
      }
      throw error;
    }
    pages += 1;

    let overlapped = false;
    let fresh = 0;
    for (const req of results) {
      if (!req || typeof req.id !== "number") continue;
      if (seen.has(req.id)) {
        overlapped = true;
        continue;
      }
      seen.add(req.id);
      fresh++;
      if (mediaType && req.type !== mediaType) continue;
      onRequest(req);
    }

    // Every page after the first must start inside rows already read; if it
    // doesn't, more rows were deleted between the two fetches than the overlap
    // covers, and an unread request may have slid under the offset.
    if (skip > 0 && !overlapped) {
      throw new Error(
        `Seerr "${instanceName}" request list changed while it was being read — try again`,
      );
    }

    if (results.length < take) break;
    if (fresh === 0) {
      throw new Error(
        `Seerr "${instanceName}" request list is not advancing — the server ignored the page offset`,
      );
    }

    skip += take - PAGE_OVERLAP;
    if (onProgress && total && total > 0) {
      onProgress(Math.min(1, (skip + PAGE_OVERLAP) / total));
    }
  }
  onProgress?.(1);
}
