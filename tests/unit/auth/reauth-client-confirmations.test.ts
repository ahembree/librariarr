import { describe, it, expect, vi, afterEach } from "vitest";
import {
  REAUTH_MESSAGE_TYPE,
  confirmIdentity,
  fetchWithReauth,
  reauthWithOidcPopup,
  reauthWithPassword,
  reauthWithPlexToken,
  reauthWithProxy,
} from "@/lib/auth/reauth-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("password / Plex / proxy confirmations", () => {
  it("posts each proof to its own route and reports success", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await reauthWithPassword("hunter2")).toEqual({ ok: true });
    expect(await reauthWithPlexToken("plex-token")).toEqual({ ok: true });
    expect(await reauthWithProxy()).toEqual({ ok: true });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "/api/auth/reauth/password",
      "/api/auth/reauth/plex",
      "/api/auth/reauth/forward",
    ]);
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ password: "hunter2" });
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ authToken: "plex-token" });
    expect(JSON.parse(String(calls[2][1].body))).toEqual({});
    expect(calls[0][1].method).toBe("POST");
  });

  it("shows the server's error, or each route's fallback when the body has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Wrong password" }, 403)));
    expect(await reauthWithPassword("x")).toEqual({ ok: false, error: "Wrong password" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 500 })));
    expect(await reauthWithPassword("x")).toEqual({ ok: false, error: "Couldn't confirm it's you" });
    expect(await reauthWithPlexToken("t")).toEqual({ ok: false, error: "Plex sign-in failed" });
    expect(await reauthWithProxy()).toEqual({ ok: false, error: "Couldn't confirm it's you" });
  });

  it("reports a network failure, but stays quiet when the caller aborted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("failed to fetch");
    }));
    expect(await reauthWithProxy()).toEqual({ ok: false, error: "Network error — try again." });

    const controller = new AbortController();
    controller.abort();
    expect(await reauthWithPassword("x", controller.signal)).toEqual({ ok: false });
  });
});

describe("confirmIdentity without a host", () => {
  it("answers false at once when nothing can show the prompt or no method is offered", async () => {
    expect(await confirmIdentity(["password"])).toBe(false);
    expect(await confirmIdentity([])).toBe(false);
  });

  it("fetchWithReauth leaves a 403 that is not a reauth refusal untouched", async () => {
    const refusal = json({ error: "forbidden" }, 403);
    vi.stubGlobal("fetch", vi.fn(async () => refusal));
    expect(await fetchWithReauth("/api/x")).toBe(refusal);

    const empty = json({ code: "reauth_required", methods: [] }, 403);
    vi.stubGlobal("fetch", vi.fn(async () => empty));
    expect(await fetchWithReauth("/api/x")).toBe(empty);

    const notJson = new Response("<html>", { status: 403 });
    vi.stubGlobal("fetch", vi.fn(async () => notJson));
    expect(await fetchWithReauth("/api/x")).toBe(notJson);
  });
});

describe("reauthWithOidcPopup edge cases", () => {
  function setup(fetchImpl: (...args: unknown[]) => Promise<Response>, closeThrows = false) {
    const popup = {
      closed: false,
      close: vi.fn(() => {
        if (closeThrows) throw new Error("severed");
        popup.closed = true;
      }),
      location: { href: "/login/reauth?pending=1" },
    };
    const handlers = new Set<(e: MessageEvent) => void>();
    vi.stubGlobal("window", {
      open: vi.fn(() => popup),
      location: { origin: "http://app.test" },
      addEventListener: (_t: string, fn: (e: MessageEvent) => void) => handlers.add(fn),
      removeEventListener: (_t: string, fn: (e: MessageEvent) => void) => handlers.delete(fn),
    });
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    return { popup, handlers };
  }

  it("does nothing when the signal is already aborted", async () => {
    const { popup } = setup(async () => json({ authorizationUrl: "https://idp" }));
    const controller = new AbortController();
    controller.abort();
    expect(await reauthWithOidcPopup(controller.signal)).toEqual({ ok: false });
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("falls back to a generic start error when the start answer names none", async () => {
    const { popup } = setup(async () => json({}, 200));
    expect(await reauthWithOidcPopup()).toEqual({ ok: false, error: "Couldn't start the SSO sign-in" });
    expect(popup.close).toHaveBeenCalled();
  });

  it("closes the popup quietly when aborted while the start was in flight", async () => {
    const controller = new AbortController();
    const { popup } = setup(async () => {
      controller.abort();
      return json({ authorizationUrl: "https://idp" });
    });
    expect(await reauthWithOidcPopup(controller.signal)).toEqual({ ok: false });
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe("/login/reauth?pending=1");
  });

  it("reports a network error from the start, tolerating a popup that cannot be closed", async () => {
    const { popup } = setup(async () => {
      throw new TypeError("offline");
    }, true);
    expect(await reauthWithOidcPopup()).toEqual({ ok: false, error: "Network error — try again." });
    expect(popup.close).toHaveBeenCalled();
  });

  it("stays quiet when the start request is aborted mid-flight", async () => {
    const controller = new AbortController();
    setup(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    expect(await reauthWithOidcPopup(controller.signal)).toEqual({ ok: false });
  });

  it("times out after ten minutes and closes the popup", async () => {
    vi.useFakeTimers();
    const { popup, handlers } = setup(async () => json({ authorizationUrl: "https://idp.test/auth" }));
    const result = reauthWithOidcPopup();
    await vi.waitFor(() => expect(popup.location.href).toBe("https://idp.test/auth"));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(await result).toEqual({ ok: false, error: "The SSO sign-in timed out. Try again." });
    expect(popup.close).toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });

  it("works without BroadcastChannel and settles only once", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const { popup, handlers } = setup(async () => json({ authorizationUrl: "https://idp.test/auth" }));
    const result = reauthWithOidcPopup();
    await vi.waitFor(() => expect(popup.location.href).toBe("https://idp.test/auth"));
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const { nonce } = JSON.parse(String(init.body)) as { nonce: string };
    const handler = [...handlers][0];
    handler({ origin: "http://app.test", data: { type: REAUTH_MESSAGE_TYPE, ok: false, error: "session_lost", nonce } } as MessageEvent);
    // A second report after settling is ignored.
    handler({ origin: "http://app.test", data: { type: REAUTH_MESSAGE_TYPE, ok: true, nonce } } as MessageEvent);
    expect(await result).toEqual({ ok: false, error: "Your session ended. Sign in again." });
  });
});
