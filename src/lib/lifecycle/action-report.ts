/**
 * What a manual run of actions reports beyond its counts: the items it failed
 * on, and the episodes or tracks of an action that ran but left them alone
 * (an episode Sonarr numbers differently, a file shared with an unmatched
 * episode, a track Lidarr does not list). Client-safe: the Query page and the
 * Pending page list both in `ActionResultDialog`.
 */

/** An item an action failed on, and why. */
export interface ActionFailure {
  title: string;
  error: string;
}

/** An episode or track an action that ran left alone, and why. */
export interface NotActedOn {
  title: string;
  reason: string;
}

/** At most this many not-acted-on members are listed per response; `notActedOnCount` counts them all. */
export const NOT_ACTED_ON_LIMIT = 200;

/**
 * A manual run's result as `POST /api/query/actions` and
 * `POST /api/lifecycle/actions/execute` answer it — the one shape both pages
 * read (each route adds its own `stopped`).
 */
export interface ActionRunDetails {
  executed: number;
  failed: number;
  /** Selected items the run left out (the query-actions route). */
  skipped?: number;
  errors?: string[];
  failures?: ActionFailure[];
  notActedOn?: NotActedOn[];
  notActedOnCount?: number;
}
