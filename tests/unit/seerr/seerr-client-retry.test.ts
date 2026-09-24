import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SeerrClient } from "@/lib/seerr/seerr-client";
import { IntegrationError } from "@/lib/integration-error";

// Drives the real axios interceptor chain (the sibling test mocks axios, so no
// interceptor ever runs there). The retry interceptor must see the raw
// AxiosError; registered after the IntegrationError conversion it only ever
// saw an IntegrationError with no `config` and rethrew every failure.
describe("SeerrClient retry", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function serve(statuses: number[]): Promise<{ url: string; hits: () => number }> {
    let hits = 0;
    server = http.createServer((_req, res) => {
      const status = statuses[Math.min(hits, statuses.length - 1)];
      hits++;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { pageInfo: { page: 1, pages: 1, results: 0 }, results: [] } : { message: "busy" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, hits: () => hits };
  }

  it("retries a transient 503 on a GET", async () => {
    const { url, hits } = await serve([503, 200]);
    const client = new SeerrClient(url, "key");
    const result = await client.getRequests({ take: 1, skip: 0 });
    expect(result.results).toEqual([]);
    expect(hits()).toBe(2);
  });

  it("still surfaces a non-retryable failure as an IntegrationError", async () => {
    const { url, hits } = await serve([401]);
    const client = new SeerrClient(url, "key");
    const error = await client.getRequests({ take: 1, skip: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).status).toBe(401);
    expect(hits()).toBe(1);
  });
});
