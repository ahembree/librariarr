import { IntegrationError } from "@/lib/integration-error";

/**
 * Whether an action failed because its Arr HOST is unusable, rather than
 * because of this one item: no response at all (refused, reset, timed out) or
 * a gateway error from a proxy in front of a stopped app. Anything else — a
 * 404 for a title no longer in the app, a 400 validation error — is specific
 * to the item and says nothing about the next one.
 */
export function isHostLevelFailure(error: unknown): boolean {
  return (
    error instanceof IntegrationError &&
    (error.status === null || error.status === 502 || error.status === 503 || error.status === 504)
  );
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
 * same outcome it used to reach in seconds. Only a failure that survived the
 * retries lands here, so a brief blip does not trip it.
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
