import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import {
  jsonResponse,
  mapInSlices,
  stringifyYielding,
  writeJsonYielding,
  STRINGIFY_SLICE_ROWS,
} from "@/lib/api/json-response";

function req(acceptEncoding?: string): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
  });
}

const bigBody = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, title: `Item ${i}` })) };

describe("jsonResponse", () => {
  // Next.js compresses Route Handler responses itself and drops a handler's own
  // Content-Encoding (GHSA-pc58-hwjq-p385): a body gzipped here would leave the
  // server gzipped twice.
  it("never compresses, even for a client that accepts gzip", async () => {
    const res = await jsonResponse(req("gzip, deflate"), bigBody);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual(bigBody);
  });

  it("preserves status and extra headers from init", async () => {
    const res = await jsonResponse(req("gzip"), bigBody, {
      status: 201,
      headers: { "X-Test": "1" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-test")).toBe("1");
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

describe("stringifyYielding", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `item-${i}`,
      added: new Date(Date.UTC(2024, 0, 1 + (i % 28))),
      size: i % 3 === 0 ? null : String(i * 1000),
      skipped: undefined,
      tags: i % 2 ? ["a", "b"] : [],
    }));

  it("is byte-for-byte JSON.stringify for a body holding a long list", async () => {
    for (const n of [STRINGIFY_SLICE_ROWS + 1, STRINGIFY_SLICE_ROWS * 2, STRINGIFY_SLICE_ROWS * 2 + 7]) {
      const body = { items: rows(n), pagination: { page: 1, limit: 0, hasMore: false }, gone: undefined, after: "x" };
      expect(await stringifyYielding(body)).toBe(JSON.stringify(body));
    }
  });

  it("serialises holes and undefined rows in a long list as null, like JSON.stringify", async () => {
    const list: unknown[] = rows(STRINGIFY_SLICE_ROWS + 5);
    list[3] = undefined;
    list[STRINGIFY_SLICE_ROWS + 1] = undefined;
    const body = { items: list };
    expect(await stringifyYielding(body)).toBe(JSON.stringify(body));
  });

  it("leaves short lists and non-plain bodies to JSON.stringify", async () => {
    const short = { items: rows(10) };
    expect(await stringifyYielding(short)).toBe(JSON.stringify(short));
    const list = rows(STRINGIFY_SLICE_ROWS + 1);
    expect(await stringifyYielding(list)).toBe(JSON.stringify(list));
    const withToJSON = { items: list, toJSON: () => ({ replaced: true }) };
    expect(await stringifyYielding(withToJSON)).toBe('{"replaced":true}');
    expect(await stringifyYielding(null)).toBe("null");
  });

  it("lets queued work run between slices", async () => {
    const order: string[] = [];
    setImmediate(() => order.push("queued"));
    const done = stringifyYielding({ items: rows(STRINGIFY_SLICE_ROWS * 3) }).then(() => order.push("done"));
    await done;
    expect(order).toEqual(["queued", "done"]);
  });

  it("is JSON.stringify for long lists nested under short ones, as the lifecycle listings send them", async () => {
    const body = {
      groups: [
        { ruleSet: { id: "a", gone: undefined }, items: rows(STRINGIFY_SLICE_ROWS + 3), count: STRINGIFY_SLICE_ROWS + 3 },
        { ruleSet: { id: "b" }, items: rows(2), count: 2 },
        undefined,
        () => "no JSON form",
      ],
      total: 7,
    };
    expect(await stringifyYielding(body)).toBe(JSON.stringify(body));
  });

  it("yields inside a nested long list", async () => {
    const order: string[] = [];
    setImmediate(() => order.push("queued"));
    await stringifyYielding({ ruleMatches: [{ items: rows(STRINGIFY_SLICE_ROWS * 2) }] }).then(() => order.push("done"));
    expect(order).toEqual(["queued", "done"]);
  });

  it("does not look past three levels", async () => {
    // Deeper lists are serialised whole, in one call — still the same output,
    // but nothing queued gets to run before it finishes.
    const order: string[] = [];
    setImmediate(() => order.push("queued"));
    const body = { a: [{ b: [{ c: rows(STRINGIFY_SLICE_ROWS * 2) }] }] };
    const text = await stringifyYielding(body);
    order.push("done");
    expect(text).toBe(JSON.stringify(body));
    expect(order).toEqual(["done"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["done", "queued"]);
  });
});

describe("writeJsonYielding", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, gone: undefined, tags: i % 2 ? ["a"] : [] }));
  const written = async (body: unknown) => {
    const chunks: string[] = [];
    await writeJsonYielding(body, (chunk) => chunks.push(chunk));
    return chunks;
  };

  it("writes JSON.stringify's text in pieces, never the whole document at once", async () => {
    const body = {
      type: "result",
      result: { items: rows(STRINGIFY_SLICE_ROWS * 3 + 2), count: 3002, skip: undefined },
      groups: [{ name: "g", items: rows(STRINGIFY_SLICE_ROWS + 1) }, undefined],
    };
    const chunks = await written(body);
    expect(chunks.join("")).toBe(JSON.stringify(body));
    const whole = JSON.stringify(body).length;
    expect(chunks.length).toBeGreaterThan(4);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(whole / 2);
  });

  it("writes a body with no long list as one piece, and nothing for one with no JSON form", async () => {
    expect(await written({ a: 1, list: rows(3) })).toEqual([JSON.stringify({ a: 1, list: rows(3) })]);
    expect(await written(undefined)).toEqual([]);
    expect(await stringifyYielding(undefined)).toBe(JSON.stringify(undefined));
  });
});

describe("mapInSlices", () => {
  it("maps every row in order", async () => {
    const input = Array.from({ length: STRINGIFY_SLICE_ROWS * 2 + 3 }, (_, i) => i);
    expect(await mapInSlices(input, (n) => n * 2)).toEqual(input.map((n) => n * 2));
    expect(await mapInSlices([], (n: number) => n)).toEqual([]);
  });

  it("lets queued work run between slices", async () => {
    const order: string[] = [];
    setImmediate(() => order.push("queued"));
    await mapInSlices(Array.from({ length: STRINGIFY_SLICE_ROWS * 2 }, (_, i) => i), (n) => n).then(() => order.push("done"));
    expect(order).toEqual(["queued", "done"]);
  });
});
