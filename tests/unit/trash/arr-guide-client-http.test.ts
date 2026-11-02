import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GuideArrClient } from "@/lib/trash/arr-guide-client";
import { IntegrationError } from "@/lib/integration-error";
import { logger } from "@/lib/logger";
import type { ArrQualityProfile } from "@/lib/trash/types";

// Every endpoint against a real local HTTP server, so the request/response
// interceptors (timing, error conversion) run with the real axios.

interface Hit {
  method: string;
  path: string;
  apiKey: string | undefined;
  body: unknown;
}

let server: http.Server | null = null;
let hits: Hit[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(status = 200, reply: (h: Hit) => unknown = (h) => ({ echoed: h.path })): Promise<string> {
  hits = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const hit: Hit = {
        method: req.method ?? "",
        path: req.url ?? "",
        apiKey: req.headers["x-api-key"] as string | undefined,
        body: raw ? JSON.parse(raw) : undefined,
      };
      hits.push(hit);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply(hit)));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

describe("GuideArrClient over HTTP", () => {
  it("reads each guide-sync resource from its v3 endpoint with the API key", async () => {
    const url = await serve();
    const c = new GuideArrClient(url, "secret", "SONARR");
    expect(await c.getLanguages()).toEqual({ echoed: "/api/v3/language" });
    expect(await c.getQualityProfiles()).toEqual({ echoed: "/api/v3/qualityprofile" });
    expect(await c.getQualityDefinitions()).toEqual({ echoed: "/api/v3/qualitydefinition" });
    expect(await c.getNamingConfig()).toEqual({ echoed: "/api/v3/config/naming" });
    expect(hits.every((h) => h.method === "GET" && h.apiKey === "secret")).toBe(true);
  });

  it("creates and updates a quality profile, injecting the id on update", async () => {
    const url = await serve(200, (h) => h.body);
    const c = new GuideArrClient(url, "k", "RADARR");
    const profile = { name: "HD", items: [] } as unknown as ArrQualityProfile;
    expect(await c.createQualityProfile(profile)).toEqual({ name: "HD", items: [] });
    expect(await c.updateQualityProfile(9, profile)).toEqual({ name: "HD", items: [], id: 9 });
    expect(hits.map((h) => `${h.method} ${h.path}`)).toEqual([
      "POST /api/v3/qualityprofile",
      "PUT /api/v3/qualityprofile/9",
    ]);
  });

  it("converts a failed request into an IntegrationError named for the service", async () => {
    // The validation-failure array every *arr 400 answers with.
    const url = await serve(400, () => [
      { propertyName: "Name", errorMessage: "Must be unique.", attemptedValue: "x", severity: "error" },
    ]);
    const c = new GuideArrClient(url, "k", "SONARR");
    const err = await c.createCustomFormat({ name: "x", specifications: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).toMatchObject({
      service: "Sonarr",
      status: 400,
      method: "POST",
      validationMessages: ["Must be unique."],
      message: "Sonarr HTTP 400: Must be unique. (/api/v3/customformat)",
    });
    // A write that the app refused is not retried.
    expect(hits).toHaveLength(1);
    expect(logger.debug).toHaveBeenCalledWith(
      "Sonarr",
      expect.stringMatching(/^ERROR 400 \/api\/v3\/customformat \(\d+ms\)$/),
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  it("reports a network failure as NETWORK", async () => {
    const url = await serve();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    // A write is not retried on a refused connection, so this fails at once.
    const err = await new GuideArrClient(url, "k", "RADARR")
      .updateNamingConfig({ id: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).status).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith("Radarr", expect.stringContaining("ERROR NETWORK"), expect.any(Object));
  });
});
