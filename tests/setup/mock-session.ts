import { vi } from "vitest";

// ---- Controllable session state ----

export interface MockSessionData {
  userId?: string;
  plexToken?: string;
  isLoggedIn: boolean;
  sessionVersion?: number;
  // Transient OIDC handshake fields. The callback reads these to validate
  // state and tell login vs link flows apart, so integration tests for the
  // callback need to seed them. The session object returned by getSession
  // proxies mutations back to `currentSession` so the route can clear them
  // via `session.oidcState = undefined; await session.save();` and the
  // assertion in the test sees the cleared state.
  oidcState?: string;
  oidcVerifier?: string;
  oidcFlow?: "link";
}

let currentSession: MockSessionData = { isLoggedIn: false };

export function setMockSession(data: MockSessionData) {
  currentSession = { ...data };
}

export function clearMockSession() {
  currentSession = { isLoggedIn: false };
}

/** Read the post-save session state for assertions. Returns a snapshot so
 *  callers can compare against later state without races. */
export function getMockSession(): MockSessionData {
  return { ...currentSession };
}

// ---- Mock next/headers ----

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockImplementation(async () => {
    const cookieMap = new Map<string, { name: string; value: string }>();
    return {
      get: (name: string) => cookieMap.get(name),
      getAll: () => Array.from(cookieMap.values()),
      has: (name: string) => cookieMap.has(name),
      set: (name: string, value: string) => {
        cookieMap.set(name, { name, value });
      },
      delete: (name: string) => {
        cookieMap.delete(name);
      },
    };
  }),
  headers: vi.fn().mockImplementation(async () => new Map()),
}));

// ---- Mock session module ----

vi.mock("@/lib/auth/session", () => ({
  // Return a Proxy so the route's mutations (e.g. `session.oidcState = "x"`,
  // `session.userId = "u1"`) write through to the module-level
  // `currentSession`. Without this, the spread-then-mutate pattern would
  // mutate a detached copy and tests couldn't observe the changes.
  getSession: vi.fn().mockImplementation(async () => {
    const proxy = new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string | symbol) {
        if (prop === "save") return async () => undefined;
        if (prop === "destroy")
          return () => {
            currentSession = { isLoggedIn: false };
          };
        return (currentSession as unknown as Record<string, unknown>)[prop as string];
      },
      set(_target, prop: string | symbol, value: unknown) {
        (currentSession as unknown as Record<string, unknown>)[prop as string] = value;
        return true;
      },
    });
    return proxy;
  }),
  isSessionValid: vi.fn().mockImplementation(async () => {
    return currentSession.isLoggedIn && !!currentSession.userId;
  }),
}));
