import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { jsonResponse, MIN_COMPRESS_BYTES } from "@/lib/api/json-response";
import { trimServerInternals, withoutServerInternals } from "@/lib/api-keys/trim-internals";

const request = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/servers", { headers });

describe("trimServerInternals", () => {
  it("strips a media server's address, machine id and owner but keeps the rest", () => {
    const server = {
      id: "s1",
      name: "Home",
      type: "PLEX",
      url: "https://192-168-1-5.abc.plex.direct:32400",
      externalUrl: "https://plex.example.com",
      machineId: "m1",
      userId: "u1",
      accessToken: "••••••••",
      enabled: true,
      libraries: [{ id: "l1", title: "Movies", type: "MOVIE" }],
    };
    expect(trimServerInternals(server)).toEqual({
      id: "s1",
      name: "Home",
      type: "PLEX",
      enabled: true,
      libraries: [{ id: "l1", title: "Movies", type: "MOVIE" }],
    });
  });

  it("recognises a server by machineId alone, and under mediaServer / playServers", () => {
    const body = {
      item: {
        id: "i1",
        title: "Arrival",
        filePath: "/data/movies/Arrival (2016)/Arrival.mkv",
        thumbUrl: "/library/metadata/1/thumb",
        library: {
          id: "l1",
          mediaServer: { id: "s1", name: "Home", url: "http://10.0.0.5:32400", externalUrl: null, machineId: "m1" },
        },
      },
      playServers: [
        { serverName: "Home", serverType: "PLEX", serverUrl: "http://10.0.0.5:32400", externalUrl: null, machineId: "m1", ratingKey: "1" },
      ],
      untyped: { id: "x", machineId: "m2", url: "http://10.0.0.6" },
    };
    expect(trimServerInternals(body)).toEqual({
      item: {
        id: "i1",
        title: "Arrival",
        thumbUrl: "/library/metadata/1/thumb",
        library: { id: "l1", mediaServer: { id: "s1", name: "Home" } },
      },
      playServers: [{ serverName: "Home", serverType: "PLEX", ratingKey: "1" }],
      untyped: { id: "x" },
    });
  });

  it("drops a stream's partFile and a stored match snapshot's filePath at any depth", () => {
    const body = {
      sessions: [
        {
          sessionId: "s1",
          userId: "u1",
          username: "alice",
          type: "movie",
          partFile: "/data/movies/Arrival (2016)/Arrival.mkv",
          partSize: 4_000_000_000,
          player: { product: "Plex Web", address: "192.168.1.20" },
        },
      ],
      ruleMatches: [
        { ruleSet: { id: "r1", type: "MOVIE" }, items: [{ id: "i1", title: "Arrival", filePath: "/data/movies/Arrival.mkv" }] },
      ],
    };
    expect(trimServerInternals(body)).toEqual({
      sessions: [
        {
          sessionId: "s1",
          userId: "u1",
          username: "alice",
          type: "movie",
          partSize: 4_000_000_000,
          player: { product: "Plex Web", address: "192.168.1.20" },
        },
      ],
      ruleMatches: [{ ruleSet: { id: "r1", type: "MOVIE" }, items: [{ id: "i1", title: "Arrival" }] }],
    });
  });

  it("keeps url and userId on objects that are not servers", () => {
    const body = { rule: { id: "r1", userId: "u1", url: "https://example.com", type: "MOVIE" }, items: [{ url: "keep" }] };
    expect(trimServerInternals(body)).toEqual(body);
  });

  it("sanitizes string error fields and leaves other errors alone", () => {
    const body = {
      jobs: [
        { id: "j1", error: "HTTP 500 (GET http://192.168.1.5:32400/library/sections): boom" },
        { id: "j2", error: null },
        { id: "j3", error: { code: 1 } },
      ],
    };
    expect(trimServerInternals(body)).toEqual({
      jobs: [
        { id: "j1", error: "HTTP 500 (GET http://[internal]:32400/library/sections): boom" },
        { id: "j2", error: null },
        { id: "j3", error: { code: 1 } },
      ],
    });
  });

  it("does not mutate its input and passes scalars through", () => {
    const input = { servers: [{ type: "EMBY", url: "http://x", name: "E" }] };
    const copy = structuredClone(input);
    trimServerInternals(input);
    expect(input).toEqual(copy);
    expect(trimServerInternals(null)).toBeNull();
    expect(trimServerInternals("text")).toBe("text");
    expect(trimServerInternals(3)).toBe(3);
  });
});

describe("withoutServerInternals", () => {
  const servers = [{ id: "s1", name: "Home", type: "JELLYFIN", url: "http://10.0.0.5:8096", machineId: "m1" }];

  it("trims a JSON response and preserves its status and headers", async () => {
    const wrapped = withoutServerInternals(async () =>
      NextResponse.json({ servers }, { status: 201, headers: { "x-custom": "yes", "cache-control": "public" } }),
    );
    const res = await wrapped(request());
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(res.headers.get("cache-control")).toBe("public");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ servers: [{ id: "s1", name: "Home", type: "JELLYFIN" }] });
  });

  it("passes the route context through", async () => {
    const wrapped = withoutServerInternals(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) =>
      NextResponse.json({ id: (await ctx.params).id, machineId: "m1" }),
    );
    const res = await wrapped(request(), { params: Promise.resolve({ id: "abc" }) });
    expect(await res.json()).toEqual({ id: "abc" });
  });

  // The handler would otherwise gzip a multi-MB body only for this wrapper to
  // inflate it and compress it again.
  it("calls the handler without Accept-Encoding, and gzips the trimmed body for a client that accepts it", async () => {
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`,
      name: `Server ${i}`.padEnd(40, "."),
      type: "PLEX",
      url: `http://10.0.0.${i % 250}:32400`,
      machineId: `machine-${i}`,
    }));
    expect(JSON.stringify({ servers: big }).length).toBeGreaterThan(MIN_COMPRESS_BYTES);
    const seen: Array<string | null> = [];
    const handlerEncodings: Array<string | null> = [];
    const wrapped = withoutServerInternals(async (req: NextRequest) => {
      seen.push(req.headers.get("accept-encoding"));
      const inner = await jsonResponse(req, { servers: big });
      handlerEncodings.push(inner.headers.get("content-encoding"));
      return inner;
    });

    const gz = await wrapped(request({ "accept-encoding": "gzip", "x-api-key": "kept" }));
    expect(seen).toEqual([null]);
    expect(handlerEncodings).toEqual([null]);
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    const body = JSON.parse(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString("utf8")) as { servers: Record<string, unknown>[] };
    expect(body.servers).toHaveLength(200);
    expect(body.servers[0]).toEqual({ id: "s0", name: big[0].name, type: "PLEX" });
    expect(JSON.stringify(body)).not.toContain("machineId");
  });

  it("returns a plain body when the handler compressed but the wrapper's client did not ask for gzip", async () => {
    // A handler that gzips regardless of the caller (the internal route saw a
    // different request) must still come back readable.
    const big = { servers: Array.from({ length: 300 }, (_, i) => ({ type: "EMBY", url: `http://10.1.1.${i % 250}`, name: `n${i}`.padEnd(30, "x") })) };
    const wrapped = withoutServerInternals(async () =>
      jsonResponse(new NextRequest("http://localhost/x", { headers: { "accept-encoding": "gzip" } }), big),
    );
    const res = await wrapped(request());
    expect(res.headers.get("content-encoding")).toBeNull();
    const parsed = (await res.json()) as { servers: Record<string, unknown>[] };
    expect(parsed.servers).toHaveLength(300);
    expect(parsed.servers.every((s) => !("url" in s))).toBe(true);
  });

  it("returns a non-JSON response untouched", async () => {
    const original = new Response("url machineId filePath", { status: 200, headers: { "content-type": "text/plain" } });
    const wrapped = withoutServerInternals(async () => original);
    const res = await wrapped(request());
    expect(res).toBe(original);
    expect(await res.text()).toBe("url machineId filePath");
  });

  it("returns an image untouched", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const original = new Response(bytes, { headers: { "content-type": "image/png" } });
    const wrapped = withoutServerInternals(async () => original);
    expect(await wrapped(request())).toBe(original);
  });

  it("trims JSON error bodies too, keeping their status", async () => {
    const wrapped = withoutServerInternals(async () =>
      NextResponse.json({ error: "Cannot reach /app/src/lib/db.ts", mediaServer: { url: "http://x" } }, { status: 500 }),
    );
    const res = await wrapped(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Cannot reach [internal]", mediaServer: {} });
  });
});
