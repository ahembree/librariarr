import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchJsonShared } from "@/lib/shared-fetch";

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
