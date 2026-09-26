import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { TracearrClient } from "@/lib/tracearr/tracearr-client";
import { GuideArrClient } from "@/lib/trash/arr-guide-client";
import { IntegrationError } from "@/lib/integration-error";

// Drives each client's REAL axios interceptor chain against a local HTTP
// server. The per-client unit tests mock axios, so no interceptor ever runs
// there — which is how every one of these clients shipped with its retry
// interceptor registered AFTER the IntegrationError conversion: the retry then
// only ever saw an IntegrationError (no `config`) and rethrew every failure.

interface Script {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

let server: http.Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** Serve `script` in order (the last entry repeats); count hits. */
async function serve(script: Script[]): Promise<{ url: string; hits: () => number; methods: string[] }> {
  let hits = 0;
  const methods: string[] = [];
  server = http.createServer((req, res) => {
    const step = script[Math.min(hits, script.length - 1)];
    hits++;
    methods.push(req.method ?? "");
    req.resume();
    res.writeHead(step.status, { "Content-Type": "application/json", ...step.headers });
    res.end(JSON.stringify(step.body ?? (step.status === 200 ? [] : { message: "busy" })));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, methods };
}

const CLIENTS: Array<{
  name: string;
  /** An idempotent read that throws on failure. */
  read: (url: string) => Promise<unknown>;
  /** The settings "Test" probe. */
  test: (url: string) => Promise<{ ok: boolean }>;
}> = [
  { name: "Radarr", read: (u) => new RadarrClient(u, "k").getMovies(), test: (u) => new RadarrClient(u, "k").testConnection() },
  { name: "Sonarr", read: (u) => new SonarrClient(u, "k").getSeries(), test: (u) => new SonarrClient(u, "k").testConnection() },
  { name: "Lidarr", read: (u) => new LidarrClient(u, "k").getArtists(), test: (u) => new LidarrClient(u, "k").testConnection() },
  {
    name: "Seerr",
    read: (u) => new SeerrClient(u, "k").getRequests({ take: 1, skip: 0 }),
    test: (u) => new SeerrClient(u, "k").testConnection(),
  },
  {
    name: "Tracearr",
    read: (u) => new TracearrClient(u, "k").getHealth(),
    test: (u) => new TracearrClient(u, "k").testConnection(),
  },
  {
    name: "TRaSH guide client",
    read: (u) => new GuideArrClient(u, "k", "RADARR").getCustomFormats(),
    test: (u) => new GuideArrClient(u, "k", "RADARR").testConnection(),
  },
];

describe.each(CLIENTS)("$name client retry", ({ read, test }) => {
  it("retries a transient 503 on a GET and succeeds", async () => {
    const { url, hits } = await serve([{ status: 503 }, { status: 200 }]);
    await expect(read(url)).resolves.toBeDefined();
    expect(hits()).toBe(2);
  });

  it("surfaces a non-retryable failure once, as an IntegrationError with its status", async () => {
    const { url, hits } = await serve([{ status: 401 }]);
    const error = await read(url).catch((e) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).status).toBe(401);
    expect(hits()).toBe(1);
  });

  it("does not retry the connection test, so it reports the first failure promptly", async () => {
    const { url, hits } = await serve([{ status: 503 }, { status: 200 }]);
    const result = await test(url);
    expect(result.ok).toBe(false);
    expect(hits()).toBe(1);
  });
});

// Once is enough: the per-client "retries a transient 503" case above already
// proves every client's interceptor order, and this one sleeps through the real
// 1s + 2s + 3s backoff.
describe("retry exhaustion", () => {
  it("wraps the final failure once retries are exhausted", async () => {
    const { url, hits } = await serve([{ status: 503 }]);
    const error = await new RadarrClient(url, "k").getMovies().catch((e) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).status).toBe(503);
    expect(hits()).toBe(4); // 1 + 3 retries
  }, 15_000);
});

describe("non-idempotent writes", () => {
  it("does not retry a 503 on a DELETE", async () => {
    // Only GET/HEAD are retried on a 5xx: the server may already have applied
    // the write, and a lifecycle delete must not be sent twice.
    const { url, hits, methods } = await serve([{ status: 503 }, { status: 200 }]);
    const error = await new RadarrClient(url, "k").deleteMovie(1).catch((e) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(hits()).toBe(1);
    expect(methods).toEqual(["DELETE"]);
  });
});

describe("Tracearr 429 handling alongside transport retries", () => {
  it("still retries a 429 on the history walk (IntegrationError keeps the status)", async () => {
    const { url, hits } = await serve([
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 200, body: { data: [], meta: { nextCursor: null } } },
    ]);
    const page = await new TracearrClient(url, "k").getHistoryPage("server-1");
    expect(page).toEqual({ records: [], nextCursor: null });
    expect(hits()).toBe(2);
  });

  it("retries a transient 503 on the history walk", async () => {
    const { url, hits } = await serve([
      { status: 503 },
      { status: 200, body: { data: [], meta: { nextCursor: null } } },
    ]);
    await new TracearrClient(url, "k").getHistoryPage("server-1");
    expect(hits()).toBe(2);
  });
});
