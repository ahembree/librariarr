/**
 * File deletes through the Arr apps that survive the app outliving the
 * request.
 *
 * Sonarr's bulk episode-file delete, Lidarr's bulk track-file delete and
 * Radarr's movie-file delete move each file into the recycle bin INSIDE the
 * request. With the recycle bin on another mount that is a copy of every file,
 * and a large selection (a long-running show's seasons) outlived the client's
 * timeout while the app went on deleting: the action was recorded FAILED
 * ("Sonarr did not answer in time (/api/v3/episodefile/bulk): ECONNABORTED")
 * for files that were in fact deleted.
 *
 * So the files go a chunk at a time (each request a bounded amount of work),
 * and a chunk whose request went unanswered is confirmed rather than failed:
 * the app's files are read back until the chunk's are gone. The wait ends
 * early when the app is gone (a read fails at the host level: that error is
 * the action's, so the run stops sending to the host) or has stopped deleting
 * (no file of the chunk gone for `DELETE_STALL_TIMEOUT_MS`), and in any case
 * after `DELETE_CONFIRM_TIMEOUT_MS`. A write is never re-sent
 * (`configureRetry`): the app may still be applying it.
 */
import { IntegrationError } from "@/lib/integration-error";
import { isHostLevelFailure } from "@/lib/lifecycle/unreachable-instances";
import { logger } from "@/lib/logger";

/** Files per delete request. */
export const FILE_DELETE_CHUNK = 25;
/** The longest an unanswered chunk is waited for, however steadily its files go. */
export const DELETE_CONFIRM_TIMEOUT_MS = 60 * 60_000;
/**
 * How long the wait goes on without one of the chunk's files going. One large
 * file copied into a recycle bin on another mount takes minutes on its own,
 * so this is generous; past it the app has stopped (a permission error
 * part-way, a restart).
 */
export const DELETE_STALL_TIMEOUT_MS = 5 * 60_000;
/** How often the app's files are read back while waiting. */
export const DELETE_CONFIRM_INTERVAL_MS = 5_000;

/**
 * Whether a write failed without an answer that says what happened: the
 * client's timeout (`ECONNABORTED`/`ETIMEDOUT`, no response), the connection
 * cut under it (`ECONNRESET`, a proxy closing an idle request), or a gateway
 * in front of the app giving up on it (502, 504, Cloudflare's 524 at 100 s).
 * The app may have applied it, or be applying it still; if it is down, the
 * read-back says so at once.
 */
export function isUnansweredWrite(error: unknown): boolean {
  if (!(error instanceof IntegrationError)) return false;
  if (error.status === 502 || error.status === 504 || error.status === 524) return true;
  return error.status === null && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || error.code === "ECONNRESET");
}

/** Where a file delete has got to: after each chunk, and while it waits on the app. */
export interface FileDeleteProgress {
  app: string;
  /** Files deleted so far. */
  deleted: number;
  total: number;
  /** Whether it is waiting for the app to finish a chunk whose request timed out. */
  waiting: boolean;
}

export interface ConfirmedDeleteOptions {
  /** The app, for log lines and errors: "Sonarr", "Lidarr", "Radarr". */
  app: string;
  /** What the ids name, for log lines and errors: "episode file", "track file", "movie file". */
  what: string;
  fileIds: readonly number[];
  /** Sends one delete request for `ids`. */
  remove: (ids: number[]) => Promise<void>;
  /** The file ids the app still has, among those this delete may have touched. */
  stillPresent: () => Promise<ReadonlySet<number>>;
  chunkSize?: number;
  /** Called before the first chunk, after each one, and when a chunk is waited on. */
  onProgress?: (progress: FileDeleteProgress) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The ids of `ids` the app still has once they are gone (none), once none has
 * gone for `DELETE_STALL_TIMEOUT_MS`, or after `DELETE_CONFIRM_TIMEOUT_MS`. A
 * read that fails on its own (the app busy with the very delete) is tried
 * again at the next interval; one that fails at the host level
 * (`isHostLevelFailure`: the connection refused, a read unanswered after its
 * retries) is thrown — the app is gone, and the run records the host as down
 * rather than waiting on it.
 */
async function awaitRemoval(
  ids: readonly number[],
  stillPresent: () => Promise<ReadonlySet<number>>,
): Promise<{ left: number[]; stalled: boolean }> {
  const deadline = Date.now() + DELETE_CONFIRM_TIMEOUT_MS;
  let left = [...ids];
  let lastProgressAt = Date.now();
  for (;;) {
    await sleep(DELETE_CONFIRM_INTERVAL_MS);
    try {
      const present = await stillPresent();
      const now = ids.filter((id) => present.has(id));
      if (now.length === 0) return { left: [], stalled: false };
      if (now.length < left.length) lastProgressAt = Date.now();
      left = now;
    } catch (error) {
      if (isHostLevelFailure(error)) throw error;
      // Unreadable for now — keep waiting.
    }
    if (Date.now() - lastProgressAt >= DELETE_STALL_TIMEOUT_MS) return { left, stalled: true };
    if (Date.now() >= deadline) return { left, stalled: false };
  }
}

/**
 * Delete `fileIds` a chunk at a time. A chunk whose request went unanswered
 * (`isUnansweredWrite`) counts as deleted once the app no longer has its
 * files; one the app still holds after the wait, or any other failure, fails
 * the delete — after the chunks before it, which are gone.
 */
export async function deleteFilesConfirmed(opts: ConfirmedDeleteOptions): Promise<void> {
  const size = opts.chunkSize ?? FILE_DELETE_CHUNK;
  const total = opts.fileIds.length;
  let done = 0;
  const report = (waiting: boolean) => opts.onProgress?.({ app: opts.app, deleted: done, total, waiting });
  report(false);
  for (let i = 0; i < total; i += size) {
    const chunk = opts.fileIds.slice(i, i + size);
    try {
      await opts.remove(chunk);
    } catch (error) {
      if (!isUnansweredWrite(error)) {
        if (done > 0) logger.warn("Lifecycle", `${opts.app} refused a delete after ${done} of ${total} ${opts.what}(s) were deleted`);
        throw error;
      }
      logger.info(
        "Lifecycle",
        `${opts.app} is still deleting ${chunk.length} ${opts.what}(s) after the request timed out — waiting for it to finish`,
      );
      report(true);
      const { left, stalled } = await awaitRemoval(chunk, opts.stillPresent);
      if (left.length > 0) {
        const before = done > 0 ? ` (${done} of ${total} deleted before)` : "";
        throw new Error(
          stalled
            ? `${opts.app} stopped deleting with ${left.length} of ${chunk.length} ${opts.what}(s) left — none went for ` +
                `${Math.round(DELETE_STALL_TIMEOUT_MS / 60_000)} minutes${before}; check its logs, then run the action again for the rest`
            : `${opts.app} had not finished deleting ${left.length} of ${chunk.length} ${opts.what}(s) after ` +
                `${Math.round(DELETE_CONFIRM_TIMEOUT_MS / 60_000)} minutes${before} — it may still be moving them to its ` +
                `recycle bin; run the action again once it has`,
        );
      }
    }
    done += chunk.length;
    report(false);
  }
}
