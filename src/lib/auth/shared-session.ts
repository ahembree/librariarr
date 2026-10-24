import { AsyncLocalStorage } from "async_hooks";

/** One request's session read, shared by every handler run inside it. */
interface SessionMemo {
  session?: Promise<unknown>;
}

const sessionMemo = new AsyncLocalStorage<SessionMemo>();

/**
 * Runs `fn` with one session read shared by everything inside it.
 *
 * Every route handler starts with `getSession()`, which unseals the cookie and
 * reads the user row to check the session is still current. A route that
 * answers several handlers' questions at once (`GET /api/settings/bundle`)
 * would otherwise make that check once per handler for the same cookie.
 * Only for handlers that READ the session: the shared object is the same one
 * each of them gets.
 */
export function withSharedSession<T>(fn: () => Promise<T>): Promise<T> {
  return sessionMemo.run({}, fn);
}

/** The shared read for this request, started by `read` on first use; `read()` itself outside `withSharedSession`. */
export function sharedSessionRead<T>(read: () => Promise<T>): Promise<T> {
  const memo = sessionMemo.getStore();
  if (!memo) return read();
  memo.session ??= read();
  return memo.session as Promise<T>;
}
