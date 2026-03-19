import { vi } from "vitest";

// ---- Controllable session state ----

export interface MockSessionData {
  userId?: string;
  plexToken?: string;
  isLoggedIn: boolean;
}

let currentSession: MockSessionData = { isLoggedIn: false };

export function setMockSession(data: MockSessionData) {
  currentSession = { ...data };
}

export function clearMockSession() {
  currentSession = { isLoggedIn: false };
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
  getSession: vi.fn().mockImplementation(async () => ({
    ...currentSession,
    save: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockImplementation(() => {
      currentSession = { isLoggedIn: false };
    }),
  })),
  isSessionValid: vi.fn().mockImplementation(async () => {
    return currentSession.isLoggedIn && !!currentSession.userId;
  }),
}));
