import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { getSession } from "@/lib/auth/session";
import { isLoggedInSession, unauthorized, withSession, type LoggedInSession } from "@/lib/auth/with-session";
import { runAsApiKey } from "@/lib/api-keys/principal";

/**
 * `withSession` is the signed-in check every app route used to write inline:
 * `getSession()`, then `{ error: "Unauthorized" }` with a 401 unless the
 * session is logged in. The session module is the suite's global mock, which
 * mirrors the real one's API-key branch; the real branch has its own test
 * (session-api-key.test.ts).
 */

const request = () => new NextRequest(new URL("http://localhost/api/test"));
type RouteHandler = (session: LoggedInSession, request: NextRequest) => Promise<Response>;

beforeEach(() => {
  clearMockSession();
  vi.mocked(getSession).mockClear();
});

describe("withSession", () => {
  it("answers exactly the inline 401 without calling the handler when nobody is signed in", async () => {
    const handler = vi.fn<RouteHandler>(async () => new Response("ok"));
    const res = await withSession(handler)(request());

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(JSON.stringify({ error: "Unauthorized" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a session marked logged in that names no user", async () => {
    setMockSession({ isLoggedIn: true });
    const handler = vi.fn<RouteHandler>(async () => new Response("ok"));
    const res = await withSession(handler)(request());
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands a signed-in session, the request and the route context to the handler", async () => {
    setMockSession({ isLoggedIn: true, userId: "u1" });
    const req = request();
    const context = { params: Promise.resolve({ id: "item-1" }) };
    const seen: unknown[] = [];
    const GET = withSession(async (session, r: NextRequest, { params }: typeof context) => {
      seen.push(session.userId, r, (await params).id);
      return Response.json({ ok: true });
    });

    const res = await GET(req, context);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["u1", req, "item-1"]);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("returns the handler's own response untouched", async () => {
    setMockSession({ isLoggedIn: true, userId: "u1" });
    const own = new Response("body", { status: 418, headers: { "x-own": "1" } });
    const res = await withSession(async () => own)();
    expect(res).toBe(own);
  });

  // The settings bundle runs its handlers with no arguments.
  it("runs a handler that reads only the session when called with no arguments", async () => {
    setMockSession({ isLoggedIn: true, userId: "u1" });
    const GET: () => Promise<Response> = withSession(async (session) => Response.json({ userId: session.userId }));
    expect(await (await GET()).json()).toEqual({ userId: "u1" });
  });

  it("runs as the key's owner under an API key, without the cookie session", async () => {
    const GET = withSession(async (session) => Response.json({ userId: session.userId }));
    const res = await runAsApiKey(
      { keyId: "k1", userId: "owner", name: "Script", prefix: "lbr_abcdef", scopes: ["media:read"] },
      () => GET(),
    );
    expect(await res.json()).toEqual({ userId: "owner" });
  });

  it("lets a handler's error propagate as it did inline", async () => {
    setMockSession({ isLoggedIn: true, userId: "u1" });
    const GET = withSession(async () => {
      throw new Error("boom");
    });
    await expect(GET()).rejects.toThrow("boom");
  });
});

describe("isLoggedInSession", () => {
  it("needs both the flag and a user id", () => {
    const base = { save: async () => {}, destroy: () => {}, updateConfig: () => {} };
    expect(isLoggedInSession({ ...base, isLoggedIn: true, userId: "u1" })).toBe(true);
    expect(isLoggedInSession({ ...base, isLoggedIn: true })).toBe(false);
    expect(isLoggedInSession({ ...base, isLoggedIn: true, userId: "" })).toBe(false);
    expect(isLoggedInSession({ ...base, isLoggedIn: false, userId: "u1" })).toBe(false);
  });
});

describe("unauthorized", () => {
  it("is a fresh response each call, so each can be read", async () => {
    const a = unauthorized();
    const b = unauthorized();
    expect(a).not.toBe(b);
    expect(await a.json()).toEqual({ error: "Unauthorized" });
    expect(await b.json()).toEqual({ error: "Unauthorized" });
  });
});
