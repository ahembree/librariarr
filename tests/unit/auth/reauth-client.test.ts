import { describe, it, expect, vi, afterEach } from "vitest";
import {
  REAUTH_CHANNEL,
  REAUTH_MESSAGE_TYPE,
  confirmIdentity,
  fetchWithReauth,
  getReauthRequest,
  reauthMethodsOf,
  reauthWithOidcPopup,
  registerReauthHost,
  subscribeReauth,
} from "@/lib/auth/reauth-client";

const refusal = (methods: unknown) =>
  new Response(JSON.stringify({ error: "needs a sign-in", code: "reauth_required", methods }), {
    status: 403,
  });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

/** Answers the next prompt with `answer`, recording the methods it offered. */
function answerNextPrompt(answer: boolean, seen: string[][] = []) {
  const unsubscribe = subscribeReauth(() => {
    const request = getReauthRequest();
    if (!request) return;
    seen.push(request.methods);
    unsubscribe();
    queueMicrotask(() => request.resolve(answer));
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reauthMethodsOf", () => {
  it("reads the methods of a reauth_required body, dropping unknown ones", () => {
    expect(
      reauthMethodsOf({ code: "reauth_required", methods: ["plex", "bogus", "oidc", "password"] }),
    ).toEqual(["plex", "oidc", "password"]);
    expect(reauthMethodsOf({ code: "reauth_required" })).toEqual([]);
  });

  it("is null for anything else", () => {
    expect(reauthMethodsOf({ code: "password_incorrect", methods: ["plex"] })).toBeNull();
    expect(reauthMethodsOf(null)).toBeNull();
    expect(reauthMethodsOf("reauth_required")).toBeNull();
  });
});

describe("fetchWithReauth", () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it("asks for confirmation and repeats the request once confirmed", async () => {
    unregister = registerReauthHost();
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal(["plex"])).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const seen = answerNextPrompt(true);

    const init = { method: "POST", body: '{"a":1}' };
    const res = await fetchWithReauth("/api/auth/plex/link", init);

    expect(res.status).toBe(200);
    expect(seen).toEqual([["plex"]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/plex/link", init);
    expect(getReauthRequest()).toBeNull();
  });

  it("returns the refusal when the prompt is dismissed", async () => {
    unregister = registerReauthHost();
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal(["oidc"]));
    vi.stubGlobal("fetch", fetchMock);
    answerNextPrompt(false);

    const res = await fetchWithReauth("/x", { method: "POST" });
    expect(res.status).toBe(403);
    // Not the server's "confirm it's you" — the prompt that offered that is gone.
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("reauth_cancelled");
    expect(body.error).toMatch(/cancelled/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not prompt when no method is available or no host is mounted", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => refusal(["plex"]));
    vi.stubGlobal("fetch", fetchMock);
    // No host mounted.
    expect((await fetchWithReauth("/x")).status).toBe(403);

    unregister = registerReauthHost();
    fetchMock.mockImplementation(async () => refusal([]));
    expect((await fetchWithReauth("/x")).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getReauthRequest()).toBeNull();
  });

  it("passes other responses through untouched", async () => {
    unregister = registerReauthHost();
    const other = new Response(JSON.stringify({ code: "password_incorrect" }), { status: 403 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(other));
    expect(await fetchWithReauth("/x")).toBe(other);
  });
});

describe("confirmIdentity", () => {
  it("a request made while a prompt is open joins it: one answer settles both", async () => {
    const unregister = registerReauthHost();
    const first = confirmIdentity(["plex"]);
    const open = getReauthRequest();
    const second = confirmIdentity(["plex"]);
    expect(getReauthRequest()).toBe(open);

    open!.resolve(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(getReauthRequest()).toBeNull();

    // The next prompt is a new one, so the dialog starts it fresh.
    const third = confirmIdentity(["plex"]);
    expect(getReauthRequest()!.id).not.toBe(open!.id);
    getReauthRequest()!.resolve(false);
    expect(await third).toBe(false);
    unregister();
  });

  it("an open prompt answers false when its host goes away", async () => {
    const unregister = registerReauthHost();
    const pending = confirmIdentity(["oidc"]);
    unregister();
    expect(await pending).toBe(false);
    expect(getReauthRequest()).toBeNull();
  });
});

describe("reauthWithOidcPopup", () => {
  const ORIGIN = "http://app.test";

  function fakeWindow() {
    const handlers = new Set<(e: MessageEvent) => void>();
    const popup = {
      closed: false,
      close: vi.fn(() => {
        popup.closed = true;
      }),
      location: { href: "/login/reauth?pending=1" },
    };
    const win = {
      open: vi.fn(() => popup),
      location: { origin: ORIGIN },
      addEventListener: (_type: string, fn: (e: MessageEvent) => void) => handlers.add(fn),
      removeEventListener: (_type: string, fn: (e: MessageEvent) => void) => handlers.delete(fn),
      dispatch: (data: unknown, origin = ORIGIN) => {
        for (const fn of [...handlers]) fn({ data, origin } as MessageEvent);
      },
      handlers,
    };
    vi.stubGlobal("window", win);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ authorizationUrl: "https://idp.test/auth" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    /** The attempt nonce the start request sent. */
    const nonce = () => {
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      return (JSON.parse(String(init.body)) as { nonce: string }).nonce;
    };
    return { win, popup, nonce };
  }

  /** Lets the fetch and popup navigation run. */
  const started = async (popup: { location: { href: string } }) => {
    await vi.waitFor(() => expect(popup.location.href).toBe("https://idp.test/auth"));
  };

  // An IdP login page that sends Cross-Origin-Opener-Policy severs the popup:
  // it reads as closed here and has no `window.opener` when it comes back, so
  // only the channel carries the report.
  it("takes the report from the BroadcastChannel even though the popup reads as closed", async () => {
    const { popup, win, nonce } = fakeWindow();
    const result = reauthWithOidcPopup();
    await started(popup);
    popup.closed = true;
    await new Promise((r) => setTimeout(r, 50));

    const sender = new BroadcastChannel(REAUTH_CHANNEL);
    sender.postMessage({ type: REAUTH_MESSAGE_TYPE, ok: true, nonce: nonce() });
    expect(await result).toEqual({ ok: true });
    sender.close();
    expect(win.handlers.size).toBe(0);
  });

  it("takes a same-origin postMessage and ignores other origins", async () => {
    const { popup, win, nonce } = fakeWindow();
    const result = reauthWithOidcPopup();
    await started(popup);

    win.dispatch({ type: REAUTH_MESSAGE_TYPE, ok: true, nonce: nonce() }, "https://evil.test");
    win.dispatch({ type: REAUTH_MESSAGE_TYPE, ok: false, error: "not_linked", nonce: nonce() });
    expect(await result).toEqual({
      ok: false,
      error: "That SSO account is not the one linked to Librariarr.",
    });
  });

  // An older popup finishing late, another tab's prompt, or /login/reauth
  // opened by hand must not settle this attempt.
  it("ignores a report for any other attempt", async () => {
    const { popup, win, nonce } = fakeWindow();
    const result = reauthWithOidcPopup();
    await started(popup);
    expect(nonce()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

    const sender = new BroadcastChannel(REAUTH_CHANNEL);
    sender.postMessage({ type: REAUTH_MESSAGE_TYPE, ok: false, error: "state_mismatch", nonce: "someone-elses-attempt" });
    win.dispatch({ type: REAUTH_MESSAGE_TYPE, ok: false, error: "state_mismatch" });
    await new Promise((r) => setTimeout(r, 50));
    win.dispatch({ type: REAUTH_MESSAGE_TYPE, ok: true, nonce: nonce() });
    expect(await result).toEqual({ ok: true });
    sender.close();
  });

  it("ends at once when the popup was closed before the sign-in started", async () => {
    const { popup, win } = fakeWindow();
    popup.closed = true;
    expect(await reauthWithOidcPopup()).toEqual({ ok: false });
    expect(popup.location.href).toBe("/login/reauth?pending=1");
    expect(win.handlers.size).toBe(0);
  });

  it("ends quietly and closes the popup when cancelled", async () => {
    const { popup } = fakeWindow();
    const controller = new AbortController();
    const result = reauthWithOidcPopup(controller.signal);
    await started(popup);

    controller.abort();
    expect(await result).toEqual({ ok: false });
    expect(popup.close).toHaveBeenCalled();
  });

  it("reports a blocked popup and a failed start", async () => {
    const { win, popup } = fakeWindow();
    win.open.mockReturnValueOnce(null as unknown as typeof popup);
    expect(await reauthWithOidcPopup()).toEqual({
      ok: false,
      error: "Allow pop-ups for this site, then try again.",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "SSO sign-in is not available" }), { status: 400 })),
    );
    expect(await reauthWithOidcPopup()).toEqual({ ok: false, error: "SSO sign-in is not available" });
    expect(popup.close).toHaveBeenCalled();
  });
});
