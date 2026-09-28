"use client";

/**
 * Browser half of in-place re-authentication (server half: reauth.ts). An
 * action that needs a recent sign-in answers 403 `reauth_required` with the
 * `methods` this account can confirm with; `fetchWithReauth` turns that into
 * a "Confirm it's you" prompt and repeats the request once confirmed, so no
 * flow ever asks the user to sign out and back in.
 */

export type ReauthMethod = "plex" | "oidc" | "forward";

const METHODS: readonly ReauthMethod[] = ["plex", "oidc", "forward"];

/** The confirmation methods a `reauth_required` body names, or null. */
export function reauthMethodsOf(data: unknown): ReauthMethod[] | null {
  if (!data || typeof data !== "object") return null;
  const body = data as { code?: unknown; methods?: unknown };
  if (body.code !== "reauth_required") return null;
  return Array.isArray(body.methods)
    ? body.methods.filter((m): m is ReauthMethod => METHODS.includes(m as ReauthMethod))
    : [];
}

export interface ReauthResult {
  ok: boolean;
  /** Shown to the user; absent when they closed the window themselves. */
  error?: string;
}

/** Message from /login/reauth, the page the OIDC callback returns the popup to. */
export const REAUTH_MESSAGE_TYPE = "librariarr:reauth";

const OIDC_ERRORS: Record<string, string> = {
  not_linked: "That SSO account is not the one linked to Librariarr.",
  state_mismatch: "The SSO sign-in expired. Try again.",
};

/**
 * Confirms the identity with the IdP in a popup, so the page — and whatever
 * the user was in the middle of — stays put. Must be called from a click: the
 * popup is opened before the first await or the browser blocks it.
 */
export async function reauthWithOidcPopup(): Promise<ReauthResult> {
  const popup = window.open("/login/reauth?pending=1", "librariarr-reauth", "width=600,height=700");
  if (!popup) return { ok: false, error: "Allow pop-ups for this site, then try again." };

  try {
    const res = await fetch("/api/auth/reauth/oidc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || typeof data?.authorizationUrl !== "string") {
      popup.close();
      return { ok: false, error: data?.error || "Couldn't start the SSO sign-in" };
    }
    popup.location.href = data.authorizationUrl;
  } catch {
    popup.close();
    return { ok: false, error: "Network error — try again." };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ReauthResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closedCheck);
      resolve(result);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== REAUTH_MESSAGE_TYPE) return;
      finish(
        e.data.ok
          ? { ok: true }
          : { ok: false, error: OIDC_ERRORS[e.data.error] ?? "SSO sign-in failed. Try again." },
      );
    };
    window.addEventListener("message", onMessage);
    // Closed without a message: cancelled. The grace period lets a message
    // posted just before the window closed arrive first.
    const closedCheck = setInterval(() => {
      if (popup.closed) setTimeout(() => finish({ ok: false }), 500);
    }, 500);
  });
}

/** Confirms the identity from the forward-auth proxy's identity header. */
export async function reauthWithProxy(): Promise<ReauthResult> {
  try {
    const res = await fetch("/api/auth/reauth/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => null);
    return { ok: false, error: data?.error || "Couldn't confirm it's you" };
  } catch {
    return { ok: false, error: "Network error — try again." };
  }
}

/** Confirms the identity with a Plex OAuth token from `usePlexOAuth`. */
export async function reauthWithPlexToken(authToken: string): Promise<ReauthResult> {
  const res = await fetch("/api/auth/reauth/plex", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authToken }),
  });
  if (res.ok) return { ok: true };
  const data = await res.json().catch(() => null);
  return { ok: false, error: data?.error || "Plex sign-in failed" };
}

// ─── The shared prompt ───────────────────────────────────────────────────
// One pending request at a time, shown by <ReauthDialogHost /> in the
// authenticated shell. Without a host mounted, `confirmIdentity` answers
// false at once and the caller shows the server's refusal as before.

export interface ReauthRequest {
  methods: ReauthMethod[];
  resolve: (confirmed: boolean) => void;
}

let current: ReauthRequest | null = null;
let hosts = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeReauth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getReauthRequest(): ReauthRequest | null {
  return current;
}

/** Called by the host on mount; the returned function on unmount. */
export function registerReauthHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
  };
}

/** Asks the user to confirm their identity. Resolves true once confirmed. */
export function confirmIdentity(methods: ReauthMethod[]): Promise<boolean> {
  if (hosts === 0 || methods.length === 0) return Promise.resolve(false);
  // A second request while one is open joins it rather than stacking dialogs.
  current?.resolve(false);
  return new Promise((resolve) => {
    current = {
      methods,
      resolve: (confirmed) => {
        if (current?.resolve === request.resolve) {
          current = null;
          emit();
        }
        resolve(confirmed);
      },
    };
    const request = current;
    emit();
  });
}

/**
 * `fetch`, except that a 403 `reauth_required` asks the user to confirm their
 * identity and, once they have, sends the request again. The body must be
 * re-sendable (a string), as every caller's JSON body is.
 */
export async function fetchWithReauth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 403) return res;
  const methods = reauthMethodsOf(await res.clone().json().catch(() => null));
  if (!methods || methods.length === 0) return res;
  if (!(await confirmIdentity(methods))) return res;
  return fetch(input, init);
}
