import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * The media-server circuit breaker is one map shared by the job worker, the
 * enforcer and the route handlers (pinned to globalThis), so a background job
 * that failed to reach a server makes every route fail fast for 45 seconds.
 * That is what it is for — except for a connection test. The Settings Test
 * button and the server edit (which tests the connection before it saves) ask
 * whether the server answers NOW, often with a config the background job did
 * not use (Skip TLS verification turned on, the breaker being keyed by URL
 * alone). Short-circuited, they reported the server unreachable without trying
 * — and the edit that would have fixed the connection was refused.
 */

let server: http.Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).mediaServerFailures;
});

/** A server that answers like Plex at `/` and like Jellyfin/Emby at `/System/Info*`. */
async function serve(): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  server = http.createServer((req, res) => {
    hits++;
    req.resume();
    const body =
      req.url === "/"
        ? { MediaContainer: { friendlyName: "Living Room" } }
        : req.url?.startsWith("/System/Info")
          ? { ServerName: "Living Room", Id: "abc" }
          : { MediaContainer: { Directory: [] } };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits };
}

/**
 * The worker's copy of the health cache marks the server down; a route's copy
 * of the client then tests it — the two module copies a production build gives
 * instrumentation and the route bundles.
 */
async function markedDownByTheWorker(url: string) {
  vi.stubEnv("NODE_ENV", "production");
  vi.resetModules();
  const worker = await import("@/lib/media-server/health-cache");
  worker.markUnreachable(url, new Error("self-signed certificate"));
  vi.resetModules();
  const route = await import("@/lib/media-server/factory");
  expect((await import("@/lib/media-server/health-cache")).isUnreachable(url)).toBe(true);
  return route.createMediaServerClient;
}

describe("a connection test while the server is marked unreachable", () => {
  for (const type of ["PLEX", "JELLYFIN", "EMBY"] as const) {
    it(`${type}: asks the server instead of answering from the breaker`, async () => {
      const { url, hits } = await serve();
      const createClient = await markedDownByTheWorker(url);

      const result = await createClient(type, url, "token", { skipTlsVerify: true }).testConnection();

      expect(result).toEqual({ ok: true, serverName: "Living Room" });
      // Plex reads `/`; Jellyfin/Emby read the public info, then the
      // authenticated one to check the key.
      expect(hits()).toBe(type === "PLEX" ? 1 : 2);
    });
  }

  it("reports the first failure instead of retrying past the breaker", async () => {
    // A breaker-bypassing request is not stopped by the mark its own first
    // failure sets, so with retries it would wait out every retry — four
    // timeouts against a host that does not answer.
    let hits = 0;
    server = http.createServer((req, res) => {
      hits++;
      req.resume();
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const createClient = await markedDownByTheWorker(url);

    for (const type of ["PLEX", "JELLYFIN", "EMBY"] as const) {
      hits = 0;
      expect((await createClient(type, url, "token").testConnection()).ok).toBe(false);
      expect(hits).toBe(1);
    }
  });

  it("still fails every other request fast", async () => {
    const { url, hits } = await serve();
    const createClient = await markedDownByTheWorker(url);

    await expect(createClient("PLEX", url, "token").getLibraries()).rejects.toMatchObject({
      code: "SERVER_UNREACHABLE",
    });
    expect(hits()).toBe(0);
  });
});
