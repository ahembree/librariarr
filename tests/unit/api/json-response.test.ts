import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { NextRequest } from "next/server";
import { jsonResponse, acceptsGzip, MIN_COMPRESS_BYTES } from "@/lib/api/json-response";

function req(acceptEncoding?: string): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
  });
}

const bigBody = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, title: `Item ${i}` })) };

describe("acceptsGzip", () => {
  it("recognises gzip in a typical browser header", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
  });

  it("returns false for a missing or unrelated header", () => {
    expect(acceptsGzip(null)).toBe(false);
    expect(acceptsGzip("br")).toBe(false);
  });

  it("honours q=0 as a refusal", () => {
    expect(acceptsGzip("gzip;q=0, br")).toBe(false);
    expect(acceptsGzip("gzip; q=0.5")).toBe(true);
  });

  it("treats a wildcard as accepting gzip unless gzip is listed explicitly", () => {
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("*, gzip;q=0")).toBe(false);
  });
});

describe("jsonResponse", () => {
  it("gzips a large body when the client accepts gzip", async () => {
    const res = await jsonResponse(req("gzip, deflate"), bigBody);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    const raw = Buffer.from(await res.arrayBuffer());
    expect(raw.byteLength).toBeLessThan(JSON.stringify(bigBody).length);
    expect(JSON.parse(gunzipSync(raw).toString("utf8"))).toEqual(bigBody);
  });

  it("sends plain JSON when the client does not accept gzip", async () => {
    const res = await jsonResponse(req(), bigBody);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(bigBody);
  });

  it("does not compress a body below the threshold", async () => {
    const small = { ok: true };
    expect(JSON.stringify(small).length).toBeLessThan(MIN_COMPRESS_BYTES);
    const res = await jsonResponse(req("gzip"), small);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(small);
  });

  it("preserves status and extra headers from init", async () => {
    const res = await jsonResponse(req("gzip"), bigBody, {
      status: 201,
      headers: { "X-Test": "1" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-test")).toBe("1");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });
});
