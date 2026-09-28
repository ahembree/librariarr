import { describe, it, expect, vi, afterEach } from "vitest";
import {
  confirmIdentity,
  fetchWithReauth,
  getReauthRequest,
  reauthMethodsOf,
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

describe("reauthMethodsOf", () => {
  it("reads the methods of a reauth_required body, dropping unknown ones", () => {
    expect(reauthMethodsOf({ code: "reauth_required", methods: ["plex", "bogus", "oidc"] })).toEqual([
      "plex",
      "oidc",
    ]);
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
    vi.unstubAllGlobals();
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
  it("a second request replaces the open one, which resolves false", async () => {
    const unregister = registerReauthHost();
    const first = confirmIdentity(["plex"]);
    const second = confirmIdentity(["oidc"]);
    expect(await first).toBe(false);
    expect(getReauthRequest()?.methods).toEqual(["oidc"]);
    getReauthRequest()!.resolve(true);
    expect(await second).toBe(true);
    expect(getReauthRequest()).toBeNull();
    unregister();
  });
});
