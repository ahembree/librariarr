import { NextResponse } from "next/server";
import {
  API_DESTRUCTIVE_PER_HOUR,
  API_DESTRUCTIVE_PER_REQUEST,
  API_DESTRUCTIVE_WINDOW_MS,
} from "./limits";

/**
 * The public API's destructive budget (see `limits.ts` for what counts and
 * why): at most `API_DESTRUCTIVE_PER_REQUEST` items per request, and at most
 * `API_DESTRUCTIVE_PER_HOUR` across every key over a rolling hour.
 *
 * A request reserves what it is about to destroy BEFORE it acts, and a refused
 * reservation charges nothing, so a request is either wholly within the budget
 * or does nothing at all — never the first N of a batch. Reserving is
 * synchronous, so concurrent requests cannot both fit into the same remainder.
 * An attempt that then fails in the Arr app is not refunded: a write that timed
 * out may still have been applied, so the budget counts what was attempted.
 * What provably never happened IS given back (`release`): an item the run
 * skipped without contacting the Arr app (its instance was down, or it was
 * cancelled meanwhile), or an exception that was already gone when the delete
 * ran. Otherwise four requests against a Radarr that is down spend every key's
 * hourly budget on deletions none of which were sent.
 *
 * Pinned to `globalThis`: the execute and exception routes reserve from a route
 * bundle, and an execution run queued through the API reserves from the job
 * worker, and each can get its own module instance. In memory like every other
 * limiter in the app, so a restart resets it — nothing in the API can restart
 * Librariarr.
 */

interface Spend {
  at: number;
  count: number;
}

const STATE = Symbol.for("librariarr.apiDestructiveBudget");

function spends(): Spend[] {
  const g = globalThis as unknown as Record<symbol, Spend[] | undefined>;
  return (g[STATE] ??= []);
}

type DestructiveRefusal =
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 429; error: string; retryAfterSeconds: number };

/** A granted reservation. `release(n)` gives back `n` of it that was never acted on. */
export interface ApiDestructiveReservation {
  ok: true;
  remaining: number;
  release: (count: number) => void;
}

type DestructiveReservation = ApiDestructiveReservation | DestructiveRefusal;

const NOTHING_TO_RELEASE = (): void => {};

/**
 * Reserve `count` destructive items for one request, or refuse the whole
 * request. `count` is what would actually be destroyed — after every other
 * guard has dropped what it drops — so the budget measures real deletions.
 */
export function reserveApiDestructive(count: number, now = Date.now()): DestructiveReservation {
  const list = spends();
  // Age out spends older than the window (the list is in time order).
  while (list.length > 0 && now - list[0].at >= API_DESTRUCTIVE_WINDOW_MS) list.shift();
  const used = list.reduce((sum, s) => sum + s.count, 0);

  if (count <= 0) {
    return { ok: true, remaining: Math.max(0, API_DESTRUCTIVE_PER_HOUR - used), release: NOTHING_TO_RELEASE };
  }

  if (count > API_DESTRUCTIVE_PER_REQUEST) {
    return {
      ok: false,
      status: 400,
      error:
        `This would delete or unprotect ${count} items; an API request may do that to at most ` +
        `${API_DESTRUCTIVE_PER_REQUEST}. Nothing was changed. Send smaller requests, or do it from Librariarr itself.`,
    };
  }

  if (used + count > API_DESTRUCTIVE_PER_HOUR) {
    // The earliest moment enough of the oldest spends have aged out for this
    // one to fit.
    let freed = 0;
    let retryAt = now + API_DESTRUCTIVE_WINDOW_MS;
    for (const s of list) {
      freed += s.count;
      if (used - freed + count <= API_DESTRUCTIVE_PER_HOUR) {
        retryAt = s.at + API_DESTRUCTIVE_WINDOW_MS;
        break;
      }
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
    const remaining = Math.max(0, API_DESTRUCTIVE_PER_HOUR - used);
    return {
      ok: false,
      status: 429,
      error:
        `API keys may delete or unprotect at most ${API_DESTRUCTIVE_PER_HOUR} items per hour; ` +
        `${remaining} remain and this needs ${count}. Nothing was changed. ` +
        `Retry in ${Math.ceil(retryAfterSeconds / 60)} minute(s), or do it from Librariarr itself.`,
      retryAfterSeconds,
    };
  }

  const spend: Spend = { at: now, count };
  list.push(spend);
  return {
    ok: true,
    remaining: API_DESTRUCTIVE_PER_HOUR - used - count,
    // Only ever out of this reservation, and never below zero: a spend that
    // has already aged out of the window is no longer counted anyway.
    release: (n: number) => {
      if (n > 0) spend.count = Math.max(0, spend.count - n);
    },
  };
}

/** The HTTP answer for a refused reservation (429s carry `Retry-After`). */
export function destructiveRefusalResponse(refusal: DestructiveRefusal): NextResponse {
  return NextResponse.json(
    { error: refusal.error },
    {
      status: refusal.status,
      headers: refusal.status === 429 ? { "Retry-After": String(refusal.retryAfterSeconds) } : undefined,
    },
  );
}

/** Forget every reservation. Tests only. */
export function resetApiDestructiveBudget(): void {
  spends().length = 0;
}
