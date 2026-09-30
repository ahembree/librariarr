"use client";

/**
 * Browser half of in-place re-authentication (server half: reauth.ts). An
 * action that needs a recent sign-in answers 403 `reauth_required` with the
 * `methods` this account can confirm with; `fetchWithReauth` turns that into
 * a "Confirm it's you" prompt and repeats the request once confirmed, so no
 * flow ever asks the user to sign out and back in.
 */

export type ReauthMethod = "plex" | "oidc" | "forward" | "password";

const METHODS: readonly ReauthMethod[] = ["plex", "oidc", "forward", "password"];

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
  /** Shown to the user; absent when they cancelled. */
  error?: string;
}

/**
 * How /login/reauth — where the OIDC callback returns the popup — reports the
 * outcome: `postMessage` to the opener, and the same message on a
 * BroadcastChannel of this name. The channel is what arrives when the IdP's
 * login page sends Cross-Origin-Opener-Policy, which severs the popup from
 * this window for good (`window.opener` is null on its return).
 */
export const REAUTH_MESSAGE_TYPE = "librariarr:reauth";
export const REAUTH_CHANNEL = "librariarr-reauth";

/** Long enough to sign in with a password manager and a second factor. */
const OIDC_TIMEOUT_MS = 10 * 60 * 1000;

const OIDC_ERRORS: Record<string, string> = {
  not_linked: "That SSO account is not the one linked to Librariarr.",
  state_mismatch: "The SSO sign-in expired. Try again.",
  session_lost: "Your session ended. Sign in again.",
};

const NETWORK_ERROR = "Network error — try again.";

/** A per-attempt id for the OIDC popup's report (see `reauthOidcStartSchema`). */
function newAttemptNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Confirms the identity with the IdP in a popup, so the page — and whatever
 * the user was in the middle of — stays put. Must be called from a click: the
 * popup is opened before the first await or the browser blocks it.
 *
 * It ends on the popup's report, on `signal` (the prompt's Cancel, or the
 * prompt going away), or after `OIDC_TIMEOUT_MS` — never on `popup.closed`:
 * an IdP page that sends Cross-Origin-Opener-Policy makes the popup read as
 * closed here while the user is still signing in on it.
 */
export async function reauthWithOidcPopup(signal?: AbortSignal): Promise<ReauthResult> {
  if (signal?.aborted) return { ok: false };
  const popup = window.open("/login/reauth?pending=1", "librariarr-reauth", "width=600,height=700");
  if (!popup) return { ok: false, error: "Allow pop-ups for this site, then try again." };
  const closePopup = () => {
    try {
      popup.close();
    } catch {
      // Severed from this window; the user closes it.
    }
  };

  const nonce = newAttemptNonce();
  try {
    const res = await fetch("/api/auth/reauth/oidc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (signal?.aborted) {
      closePopup();
      return { ok: false };
    }
    if (!res.ok || typeof data?.authorizationUrl !== "string") {
      closePopup();
      return { ok: false, error: data?.error || "Couldn't start the SSO sign-in" };
    }
    // Still our own page here, so `closed` is reliable: a window closed while
    // the start was in flight would otherwise leave the prompt waiting for
    // the full timeout on a sign-in nobody can finish.
    if (popup.closed) return { ok: false };
    popup.location.href = data.authorizationUrl;
  } catch {
    closePopup();
    return signal?.aborted ? { ok: false } : { ok: false, error: NETWORK_ERROR };
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      closePopup();
      finish({ ok: false, error: "The SSO sign-in timed out. Try again." });
    }, OIDC_TIMEOUT_MS);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(REAUTH_CHANNEL);

    const finish = (result: ReauthResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onWindowMessage);
      signal?.removeEventListener("abort", onAbort);
      channel?.close();
      clearTimeout(timeout);
      resolve(result);
    };
    const onReport = (data: unknown) => {
      const report = data as { type?: unknown; ok?: unknown; error?: unknown; nonce?: unknown } | null;
      // Only this attempt's report: an older popup finishing late, another
      // tab's prompt, or /login/reauth opened by hand must not settle it.
      if (report?.type !== REAUTH_MESSAGE_TYPE || report.nonce !== nonce) return;
      finish(
        report.ok === true
          ? { ok: true }
          : { ok: false, error: OIDC_ERRORS[String(report.error)] ?? "SSO sign-in failed. Try again." },
      );
    };
    const onWindowMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin) onReport(e.data);
    };
    const onAbort = () => {
      closePopup();
      finish({ ok: false });
    };

    window.addEventListener("message", onWindowMessage);
    if (channel) channel.onmessage = (e) => onReport(e.data);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function postConfirmation(
  url: string,
  body: unknown,
  fallback: string,
  signal?: AbortSignal,
): Promise<ReauthResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => null);
    return { ok: false, error: data?.error || fallback };
  } catch {
    return signal?.aborted ? { ok: false } : { ok: false, error: NETWORK_ERROR };
  }
}

/** Confirms the identity from the forward-auth proxy's identity header. */
export function reauthWithProxy(signal?: AbortSignal): Promise<ReauthResult> {
  return postConfirmation("/api/auth/reauth/forward", {}, "Couldn't confirm it's you", signal);
}

/** Confirms the identity with a Plex OAuth token from `usePlexOAuth`. */
export function reauthWithPlexToken(authToken: string): Promise<ReauthResult> {
  return postConfirmation("/api/auth/reauth/plex", { authToken }, "Plex sign-in failed");
}

/** Confirms the identity with the account's current password. */
export function reauthWithPassword(password: string, signal?: AbortSignal): Promise<ReauthResult> {
  return postConfirmation("/api/auth/reauth/password", { password }, "Couldn't confirm it's you", signal);
}

// ─── The shared prompt ───────────────────────────────────────────────────
// One prompt at a time, shown by <ReauthDialogHost />. A request made while
// one is open joins it: one confirmation answers both. Without a host
// mounted, `confirmIdentity` answers false at once and the caller shows the
// server's refusal as before.

export interface ReauthRequest {
  /** Distinct per prompt, so the dialog starts each one fresh. */
  id: number;
  methods: ReauthMethod[];
  resolve: (confirmed: boolean) => void;
}

let current: ReauthRequest | null = null;
/** Everyone waiting on the open prompt: its opener and any request that joined. */
let waiters: Array<(confirmed: boolean) => void> = [];
let nextRequestId = 0;
let hosts = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function settle(id: number, confirmed: boolean) {
  if (current?.id !== id) return;
  const answered = waiters;
  current = null;
  waiters = [];
  emit();
  for (const answer of answered) answer(confirmed);
}

export function subscribeReauth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReauthRequest(): ReauthRequest | null {
  return current;
}

/** Called by the host on mount; the returned function on unmount. */
export function registerReauthHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
    // Nothing is left to show the open prompt; its callers must not hang.
    if (hosts === 0) current?.resolve(false);
  };
}

/** Asks the user to confirm their identity. Resolves true once confirmed. */
export function confirmIdentity(methods: ReauthMethod[]): Promise<boolean> {
  if (hosts === 0 || methods.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    waiters.push(resolve);
    if (current) return; // Joins the open prompt.
    const id = ++nextRequestId;
    current = { id, methods, resolve: (confirmed) => settle(id, confirmed) };
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
  if (!(await confirmIdentity(methods))) return reauthCancelled();
  return fetch(input, init);
}

/**
 * What a caller gets when the prompt was dismissed: the server's refusal asks
 * the user to "confirm it's you", which reads as a dead end once the prompt
 * that would have let them do so has gone.
 */
function reauthCancelled(): Response {
  return new Response(
    JSON.stringify({
      error: "Cancelled — confirm it's you to continue. Try again when you're ready.",
      code: "reauth_cancelled",
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}
