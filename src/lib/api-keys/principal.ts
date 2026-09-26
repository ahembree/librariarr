import { AsyncLocalStorage } from "node:async_hooks";
import type { IronSession } from "iron-session";
import type { SessionData } from "@/lib/auth/session";
import type { ApiScope } from "./scopes";

/** The API key a `/api/v1` request authenticated with. */
export interface ApiKeyPrincipal {
  keyId: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: readonly ApiScope[];
}

/**
 * The key a request is running under, scoped to that request's async context.
 *
 * `withApiKey` is the ONLY writer: it authenticates the key and checks the
 * scope first, then runs the handler inside `runAsApiKey`. `getSession()`
 * reads it, so a handler shared with the app's own UI sees the key's owner as
 * the logged-in user without knowing an API key was involved — and no route
 * outside `/api/v1` can ever run under one, because nothing else writes it.
 *
 * Pinned to `globalThis` like the event bus: the guard and the session module
 * must share one store even if a bundler gives them separate module instances.
 */
const globalForPrincipal = globalThis as unknown as {
  __librariarrApiKeyPrincipal?: AsyncLocalStorage<ApiKeyPrincipal>;
};
const storage = (globalForPrincipal.__librariarrApiKeyPrincipal ??=
  new AsyncLocalStorage<ApiKeyPrincipal>());

export function runAsApiKey<T>(principal: ApiKeyPrincipal, fn: () => T): T {
  const frozen = Object.freeze({ ...principal, scopes: Object.freeze([...principal.scopes]) });
  return storage.run(frozen, fn);
}

export function getApiKeyPrincipal(): ApiKeyPrincipal | undefined {
  return storage.getStore();
}

/**
 * The session `getSession()` returns under an API key: logged in as the key's
 * owner and nothing more. It carries no Plex token and no session version, and
 * it refuses every write — an API request has no cookie to save or destroy and
 * must never mint one. Frozen, so a handler assigning a field throws instead of
 * quietly writing to an object nobody persists.
 */
export function apiKeySession(principal: ApiKeyPrincipal): IronSession<SessionData> {
  const refuse = (): never => {
    throw new Error("An API key request has no cookie session to modify");
  };
  return Object.freeze({
    isLoggedIn: true,
    userId: principal.userId,
    save: async () => refuse(),
    destroy: () => refuse(),
    updateConfig: () => refuse(),
  }) as IronSession<SessionData>;
}
