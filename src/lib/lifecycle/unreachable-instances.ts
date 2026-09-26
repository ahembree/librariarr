import { IntegrationError } from "@/lib/integration-error";

// Failures while CONNECTING: nothing was sent, so they describe the host and
// not the item, whatever the method.
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EAI_AGAIN",
]);

/**
 * Whether an action failed because its Arr HOST is unusable, rather than
 * because of this one item: the connection could not be made at all, or a
 * READ that went unanswered (timeout, reset) or drew a gateway error from a
 * proxy in front of a stopped app — after `configureRetry` had retried it.
 *
 * A write's timeout or gateway error does not qualify. Writes are never
 * retried (they may already have been applied), so it is one unanswered
 * request, not a verdict on the host — and some writes are legitimately slow:
 * Sonarr's bulk episode-file delete moves the files into the recycle bin inside
 * the request, which on a recycle bin mounted elsewhere is a multi-gigabyte
 * copy that outlives the client timeout while Sonarr is perfectly healthy.
 * Counted as host-level, that one slow delete failed every remaining item of a
 * manual run unsent. Anything else — a 404 for a title no longer in the app, a
 * 400 validation error — is specific to the item and says nothing about the
 * next one.
 */
export function isHostLevelFailure(error: unknown): boolean {
  if (!(error instanceof IntegrationError)) return false;
  if (CONNECT_FAILURE_CODES.has(error.code)) return true;
  const unanswered =
    error.status === null || error.status === 502 || error.status === 503 || error.status === 504;
  if (!unanswered || error.code === "ERR_CANCELED") return false;
  return error.method === "GET" || error.method === "HEAD";
}

/**
 * Per-run record of Arr instances that just failed at the host level.
 *
 * The action loops run one item at a time, and every item's first request
 * goes to the same instance. With transport retries in place, each attempt
 * against a dead instance costs the client's whole retry budget (four 15s
 * timeouts plus backoff, or ~6s against a proxy answering 502) — per item, so
 * a 150-item "Execute" against a down Radarr held the request (and, in the
 * scheduled executor, the serial MAIN_QUEUE) for tens of minutes to reach the
 * same outcome it used to reach in seconds. Only a refused connection or a read
 * that survived the retries lands here, so a brief blip does not trip it.
 */
export class UnreachableInstances {
  private readonly down = new Map<string, unknown>();

  /** The host-level error that took `instanceId` down this run, if any. */
  get(instanceId: string | null | undefined): unknown {
    return instanceId ? this.down.get(instanceId) : undefined;
  }

  /** Remember `error` against `instanceId` when it is a host-level failure. */
  record(instanceId: string | null | undefined, error: unknown): boolean {
    if (!instanceId || !isHostLevelFailure(error)) return false;
    if (!this.down.has(instanceId)) this.down.set(instanceId, error);
    return true;
  }
}
