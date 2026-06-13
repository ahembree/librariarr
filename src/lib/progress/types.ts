/**
 * Shared progress-streaming protocol for long-running, multi-phase API routes
 * (query execution, lifecycle rule preview). The server streams newline-
 * delimited JSON (NDJSON): one `plan` event up front listing the phases it will
 * run, then `phase` events as it advances (with an optional 0..1 `fraction` for
 * determinate sub-progress), and finally a `result` (or `error`) envelope.
 *
 * This mirrors the backup-restore streaming pattern but generalizes it so both
 * the rule and query builders can render a real progress bar.
 */

export interface ProgressPhase {
  /** Stable machine key, e.g. "arr", "query", "evaluate". */
  key: string;
  /** Human-readable label shown in the UI, e.g. "Fetching Radarr data". */
  label: string;
}

/** Progress events forwarded to the UI as work proceeds. */
export type ProgressUpdate =
  | { type: "plan"; phases: ProgressPhase[] }
  | {
      type: "phase";
      key: string;
      fraction?: number;
      /**
       * Optional human-readable sub-status for the active phase (e.g. a per-item
       * count plus the item and step currently being processed). Shown beneath
       * the phase label; cleared automatically on any phase event that omits it.
       */
      detail?: string;
    };

/** Callback an engine/route uses to report progress. */
export type ProgressEmit = (update: ProgressUpdate) => void;

/** Full wire envelope (progress events plus terminal result/error). */
export type ProgressWireEvent =
  | ProgressUpdate
  | { type: "result"; result: unknown }
  | { type: "error"; message: string };
