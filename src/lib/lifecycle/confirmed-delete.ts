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
 * the app's files are read back until the chunk's are gone, for up to
 * `DELETE_CONFIRM_TIMEOUT_MS`. A write is never re-sent (`configureRetry`):
 * the app may still be applying it.
 */
import { IntegrationError } from "@/lib/integration-error";
import { logger } from "@/lib/logger";

/** Files per delete request. */
export const FILE_DELETE_CHUNK = 25;
/** How long an unanswered chunk is waited for before the action fails. */
export const DELETE_CONFIRM_TIMEOUT_MS = 15 * 60_000;
/** How often the app's files are read back while waiting. */
export const DELETE_CONFIRM_INTERVAL_MS = 5_000;

/**
 * Whether a write failed without an answer that says what happened: the
 * client's timeout (`ECONNABORTED`/`ETIMEDOUT`, no response) or a gateway in
 * front of the app giving up on it (504). The app may have applied it, or be
 * applying it still.
 */
export function isUnansweredWrite(error: unknown): boolean {
  if (!(error instanceof IntegrationError)) return false;
  if (error.status === 504) return true;
  return error.status === null && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT");
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
 * The ids of `ids` the app still has once it stops removing them, or after
 * `DELETE_CONFIRM_TIMEOUT_MS`. A read that fails (the app busy with the very
 * delete) is retried at the next interval.
 */
async function awaitRemoval(ids: readonly number[], stillPresent: () => Promise<ReadonlySet<number>>): Promise<number[]> {
  const deadline = Date.now() + DELETE_CONFIRM_TIMEOUT_MS;
  let left = [...ids];
  for (;;) {
    await sleep(DELETE_CONFIRM_INTERVAL_MS);
    try {
      const present = await stillPresent();
      left = ids.filter((id) => present.has(id));
      if (left.length === 0) return [];
    } catch {
      // Unreadable for now — keep waiting.
    }
    if (Date.now() >= deadline) return left;
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
      const left = await awaitRemoval(chunk, opts.stillPresent);
      if (left.length > 0) {
        throw new Error(
          `${opts.app} had not finished deleting ${left.length} of ${chunk.length} ${opts.what}(s) after ` +
            `${Math.round(DELETE_CONFIRM_TIMEOUT_MS / 60_000)} minutes` +
            (done > 0 ? ` (${done} of ${total} deleted before)` : "") +
            ` — it may still be moving them to its recycle bin; run the action again once it has`,
        );
      }
    }
    done += chunk.length;
    report(false);
  }
}
