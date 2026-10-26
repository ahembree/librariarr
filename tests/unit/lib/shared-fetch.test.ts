import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchJsonShared, fetchShared, newRequestScope, runInRequestScope } from "@/lib/shared-fetch";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ n: fetchMock.mock.calls.length }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJsonShared", () => {
  it("shares one request between callers in the same turn", async () => {
    const [a, b] = await Promise.all([fetchJsonShared("/api/x"), fetchJsonShared("/api/x")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ n: 1 });
    expect(b).toBe(a);
  });

  it("asks again in a later turn", async () => {
    await fetchJsonShared("/api/x");
    await Promise.resolve();
    await fetchJsonShared("/api/x");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps different URLs apart and sends the first caller's init", async () => {
    await Promise.all([
      fetchJsonShared("/api/x", { priority: "low" } as RequestInit),
      fetchJsonShared("/api/x"),
      fetchJsonShared("/api/y"),
    ]);
    expect(fetchMock.mock.calls).toEqual([["/api/x", { priority: "low" }], ["/api/y"]]);
  });

  it("answers null for an error status or a failed request", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect(await fetchJsonShared("/api/x")).toBeNull();
    await Promise.resolve();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchJsonShared("/api/x")).toBeNull();
  });
});

describe("fetchShared", () => {
  it("shares the request with fetchJsonShared and keeps an error status's body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "nope" }), { status: 409 }));
    const [detailed, json] = await Promise.all([fetchShared("/api/x"), fetchJsonShared("/api/x")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(detailed).toEqual({ ok: false, status: 409, body: { error: "nope" } });
    expect(json).toBeNull();
  });

  it("answers status 0 for a failed request and a null body for one that is not JSON", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchShared("/api/x")).toEqual({ ok: false, status: 0, body: null });
    await Promise.resolve();
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await fetchShared("/api/x")).toEqual({ ok: true, status: 200, body: null });
  });
});

describe("fetchJsonShared inside a request scope", () => {
  it("shares one request across turns within one scope, and drops it once answered", async () => {
    const scope = newRequestScope();
    const first = runInRequestScope(scope, () => fetchJsonShared("/api/x"));
    // The browser runs microtasks between an event's listeners: the next
    // subscriber of the same event is a later turn, in the same scope.
    await Promise.resolve();
    const second = runInRequestScope(scope, () => fetchJsonShared("/api/x"));
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await first;
    await Promise.resolve();
    // A late caller in that scope gets a fresh answer, never a settled one.
    await runInRequestScope(scope, () => fetchJsonShared("/api/x"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never shares between two scopes, or between a scope and no scope", async () => {
    const a = newRequestScope();
    const b = newRequestScope();
    const outside = fetchJsonShared("/api/x");
    const inA = runInRequestScope(a, () => fetchJsonShared("/api/x"));
    const inB = runInRequestScope(b, () => fetchJsonShared("/api/x"));
    expect(new Set([outside, inA, inB]).size).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await Promise.all([outside, inA, inB]);
  });

  it("restores the outer scope, also when the callback throws", async () => {
    const a = newRequestScope();
    expect(() =>
      runInRequestScope(a, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // Back outside any scope: same-turn sharing as before.
    const x = fetchJsonShared("/api/x");
    const y = fetchJsonShared("/api/x");
    expect(x).toBe(y);
    expect(runInRequestScope(a, () => 7)).toBe(7);
    await x;
  });
});
