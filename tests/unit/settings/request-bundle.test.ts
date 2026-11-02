import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequestBundle } from "@/lib/settings/request-bundle";

let fetchMock: ReturnType<typeof vi.fn>;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRequestBundle", () => {
  it("answers every path's first read from one bundle request", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        parts: {
          "/api/a": { status: 200, body: { a: 1 } },
          "/api/b": { status: 404, body: { error: "gone" } },
        },
      }),
    );
    const bundle = createRequestBundle("/api/bundle", ["/api/a", "/api/b"]);
    const [a, b] = await Promise.all([bundle.get("/api/a"), bundle.get("/api/b")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/bundle?paths=${encodeURIComponent("/api/a,/api/b")}`);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ a: 1 });
    expect(b.ok).toBe(false);
    expect(await b.json()).toEqual({ error: "gone" });
  });

  it("sends a later read of the same path, and any other path, to the route", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { parts: { "/api/a": { status: 200, body: 1 } } }));
    const bundle = createRequestBundle("/api/bundle", ["/api/a"]);
    await bundle.get("/api/a");

    fetchMock.mockResolvedValueOnce(json(200, 2));
    expect(await (await bundle.get("/api/a")).json()).toBe(2);
    fetchMock.mockResolvedValueOnce(json(200, 3));
    expect(await (await bundle.get("/api/other")).json()).toBe(3);
    expect(fetchMock.mock.calls.slice(1).map((c) => c[0])).toEqual(["/api/a", "/api/other"]);
  });

  it("falls back to the route when the bundle fails or lacks the path", async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: "x" }));
    const failed = createRequestBundle("/api/bundle", ["/api/a"]);
    fetchMock.mockResolvedValueOnce(json(200, "direct"));
    expect(await (await failed.get("/api/a")).json()).toBe("direct");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const unreachable = createRequestBundle("/api/bundle", ["/api/a"]);
    fetchMock.mockResolvedValueOnce(json(200, "direct"));
    expect(await (await unreachable.get("/api/a")).json()).toBe("direct");

    fetchMock.mockResolvedValueOnce(json(200, { parts: {} }));
    const missing = createRequestBundle("/api/bundle", ["/api/a"]);
    fetchMock.mockResolvedValueOnce(json(200, "direct"));
    expect(await (await missing.get("/api/a")).json()).toBe("direct");
  });

  it("gives a bodiless status no body", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { parts: { "/api/a": { status: 204, body: null } } }));
    const res = await createRequestBundle("/api/bundle", ["/api/a"]).get("/api/a");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
