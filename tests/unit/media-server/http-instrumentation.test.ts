import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";

// The shared interceptor chain both media-server clients install, driven with
// a real axios instance against a local HTTP server.

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "@/lib/logger";
import {
  instrumentMediaServerClient,
  normalizeMediaServerUrl,
} from "@/lib/media-server/http-instrumentation";
import {
  _resetForTesting,
  BYPASS_BREAKER,
  isUnreachable,
  markUnreachable,
  ServerUnreachableError,
} from "@/lib/media-server/health-cache";
import { NO_RETRY } from "@/lib/http-retry";
import { PlexClient } from "@/lib/plex/client";
import { JellyfinClient } from "@/lib/jellyfin/client";

let server: http.Server | null = null;
let seen: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];

async function serve(status = 200, body: unknown = { ok: true }): Promise<string> {
  seen = [];
  server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  _resetForTesting();
  vi.clearAllMocks();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

function instrumented(baseURL: string, extra: Partial<Parameters<typeof instrumentMediaServerClient>[1]> = {}) {
  const client = axios.create({ baseURL });
  instrumentMediaServerClient(client, { baseURL, logPrefix: () => "Test", ...extra });
  return client;
}

describe("normalizeMediaServerUrl", () => {
  it("drops trailing slashes and nothing else", () => {
    expect(normalizeMediaServerUrl("http://plex:32400/")).toBe("http://plex:32400");
    expect(normalizeMediaServerUrl("http://plex:32400///")).toBe("http://plex:32400");
    expect(normalizeMediaServerUrl("https://host/jellyfin")).toBe("https://host/jellyfin");
  });
});

describe("instrumentMediaServerClient", () => {
  it("refuses a request to a server marked unreachable, unless it bypasses the breaker", async () => {
    const url = await serve();
    const client = instrumented(url);
    markUnreachable(url, new Error("ECONNREFUSED"));

    await expect(client.get("/x")).rejects.toBeInstanceOf(ServerUnreachableError);
    expect(seen).toHaveLength(0);

    await expect(client.get("/x", { ...BYPASS_BREAKER })).resolves.toMatchObject({ status: 200 });
    // A success clears the mark for every later request.
    expect(isUnreachable(url)).toBe(false);
  });

  it("marks the server unreachable when nothing answers", async () => {
    const url = await serve();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const client = instrumented(url);

    await expect(client.get("/x", { ...NO_RETRY })).rejects.toThrow();
    expect(isUnreachable(url)).toBe(true);
  });

  it("runs beforeRequest on every request, after the breaker check", async () => {
    const url = await serve();
    const client = instrumented(url, {
      beforeRequest: (config) => {
        config.headers.set("X-Test-Auth", "secret");
      },
    });

    await client.get("/a");
    expect(seen[0].headers["x-test-auth"]).toBe("secret");
  });

  it("keeps quiet requests out of the debug log, but logs their failures with the server's detail", async () => {
    const url = await serve(400, { message: "bad item" });
    const client = instrumented(url, { quiet: (path) => path?.startsWith("/library/metadata/") ?? false });

    await expect(client.get("/library/metadata/1")).rejects.toThrow();
    const lines = vi.mocked(logger.debug).mock.calls.map((call) => call[1] as string);
    expect(lines.some((line) => line.startsWith("GET /library/metadata/1"))).toBe(false);
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      "Test",
      "ERROR 400 /library/metadata/1",
      expect.objectContaining({ detail: "bad item" }),
    );

    vi.mocked(logger.debug).mockClear();
    await expect(client.get("/status")).rejects.toThrow();
    expect(vi.mocked(logger.debug).mock.calls.map((call) => call[1])).toContain("GET /status");
  });
});

describe("the clients share one base-URL spelling", () => {
  it("a Plex server saved with a trailing slash builds URLs without a double slash, under the breaker's key", async () => {
    const url = await serve();
    const plex = new PlexClient(`${url}/`, "token");

    expect(plex.getImageUrl("/library/metadata/1/thumb")).toBe(`${url}/library/metadata/1/thumb?X-Plex-Token=token`);

    markUnreachable(`${url}/`, new Error("down"));
    await expect(plex.getLibraries()).rejects.toMatchObject({ baseURL: url });
  });

  it("Jellyfin keeps its normalized base URL", async () => {
    const url = await serve();
    const jellyfin = new JellyfinClient(`${url}//`, "key");
    markUnreachable(url, new Error("down"));
    await expect(jellyfin.getLibraries()).rejects.toMatchObject({ baseURL: url });
  });
});
