import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_CARD_BATCH_LIMIT,
  CUSTOM_CARD_BATCH_URL,
  createCustomCardBatcher,
  customCardDataFrom,
  customCardRequest,
  customCardRequestKey,
  postCustomCardBatch,
  type CustomCardAnswer,
  type CustomCardRequest,
} from "@/lib/dashboard/custom-card-data";
import { MAX_CUSTOM_STATS_BATCH, customStatsBatchSchema } from "@/lib/validation";
import type { CustomCardConfig } from "@/lib/dashboard/card-registry";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("customCardRequest", () => {
  it("asks a timeline for its date field, bin, breakdown, top-N, server and type", () => {
    const config: CustomCardConfig = {
      chartType: "timeline",
      dimension: "addedAt",
      dimension2: "resolution",
      timelineBin: "year",
      topN: 5,
    };
    expect(customCardRequest(config, { serverId: "srv-1", filterType: "MOVIE" })).toEqual({
      kind: "timeline",
      dateField: "addedAt",
      bin: "year",
      breakdown: "resolution",
      topN: 5,
      serverId: "srv-1",
      type: "MOVIE",
    });
  });

  it("leaves out what a timeline's own request left out", () => {
    const config = { chartType: "timeline", dimension: "addedAt" } as CustomCardConfig;
    expect(customCardRequest(config, {})).toEqual({ kind: "timeline", dateField: "addedAt", bin: "month" });
    expect(customCardRequest({ ...config, topN: null }, {})).not.toHaveProperty("topN");
  });

  it("sends a top-N the route would have read with parseInt as an integer the batch accepts", () => {
    const config = { chartType: "timeline", dimension: "addedAt", timelineBin: "month" } as CustomCardConfig;
    expect(customCardRequest({ ...config, topN: 7.9 }, {})).toMatchObject({ topN: 7 });
    expect(customCardRequest({ ...config, topN: 50_000 }, {})).toMatchObject({ topN: 10_000 });
    expect(customCardRequest({ ...config, topN: Number.NaN }, {})).not.toHaveProperty("topN");
    // Every one of them is a card the batch's schema takes.
    for (const topN of [7.9, 50_000, 0, 1]) {
      const parsed = customStatsBatchSchema.safeParse({ cards: [customCardRequest({ ...config, topN }, {})] });
      expect(parsed.success).toBe(true);
    }
  });

  it("asks a heatmap for the cross-tab of its two dimensions, never by type", () => {
    const config: CustomCardConfig = { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" };
    expect(customCardRequest(config, { serverId: "srv-1", filterType: "MOVIE" })).toEqual({
      kind: "crossTab",
      dimension1: "resolution",
      dimension2: "videoCodec",
      serverId: "srv-1",
    });
  });

  it("asks a heatmap with no second dimension for its breakdown, as it always did", () => {
    const config = { chartType: "heatmap", dimension: "resolution" } as CustomCardConfig;
    expect(customCardRequest(config, {})).toEqual({ kind: "custom", dimension: "resolution" });
  });

  it("asks every other chart for its dimension's breakdown, never by type", () => {
    for (const chartType of ["pie", "bar", "count"] as const) {
      const config = { chartType, dimension: "genre" } as CustomCardConfig;
      expect(customCardRequest(config, { filterType: "SERIES" })).toEqual({ kind: "custom", dimension: "genre" });
    }
  });

  it("gives a type change on a breakdown the same key, and on a timeline a new one", () => {
    const breakdown = { chartType: "pie", dimension: "genre" } as CustomCardConfig;
    expect(customCardRequestKey(customCardRequest(breakdown, { filterType: "MOVIE" }))).toBe(
      customCardRequestKey(customCardRequest(breakdown, {})),
    );
    const timeline = { chartType: "timeline", dimension: "addedAt", timelineBin: "month" } as CustomCardConfig;
    expect(customCardRequestKey(customCardRequest(timeline, { filterType: "MOVIE" }))).not.toBe(
      customCardRequestKey(customCardRequest(timeline, {})),
    );
  });

  it("builds requests the batch route's schema accepts", () => {
    const configs: CustomCardConfig[] = [
      { chartType: "timeline", dimension: "addedAt", dimension2: "resolution", timelineBin: "week", topN: 10 },
      { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" },
      { chartType: "bar", dimension: "genre" },
    ];
    const cards = configs.map((c) => customCardRequest(c, { serverId: "srv-1", filterType: "MUSIC" }));
    expect(customStatsBatchSchema.safeParse({ cards }).success).toBe(true);
  });
});

describe("customCardDataFrom", () => {
  it("reads each route's body", () => {
    expect(customCardDataFrom("timeline", { status: 200, body: { points: [{ date: "2024", total: 1 }], series: ["4K"] } })).toEqual({
      kind: "timeline",
      timeline: { points: [{ date: "2024", total: 1 }], series: ["4K"] },
    });
    expect(customCardDataFrom("crossTab", { status: 200, body: { rows: [{ dim1: "a", dim2: "b", type: "MOVIE", _count: 2 }] } })).toEqual({
      kind: "crossTab",
      rows: [{ dim1: "a", dim2: "b", type: "MOVIE", _count: 2 }],
    });
    expect(customCardDataFrom("custom", { status: 200, body: { breakdown: [{ value: "x", type: "MOVIE", _count: 3 }] } })).toEqual({
      kind: "custom",
      breakdown: [{ value: "x", type: "MOVIE", _count: 3 }],
    });
  });

  it("reads a missing list as empty — data, not a failure", () => {
    expect(customCardDataFrom("timeline", { status: 200, body: {} })).toEqual({
      kind: "timeline",
      timeline: { points: [], series: [] },
    });
    expect(customCardDataFrom("crossTab", { status: 200, body: {} })).toEqual({ kind: "crossTab", rows: [] });
    expect(customCardDataFrom("custom", { status: 200, body: {} })).toEqual({ kind: "custom", breakdown: [] });
  });

  it("is null for an error status, a failed request or a body that is not JSON", () => {
    expect(customCardDataFrom("crossTab", { status: 500, body: { error: "boom" } })).toBeNull();
    expect(customCardDataFrom("custom", { status: 400, body: { error: "Invalid dimension" } })).toBeNull();
    expect(customCardDataFrom("timeline", { status: 0, body: null })).toBeNull();
    expect(customCardDataFrom("custom", { status: 200, body: null })).toBeNull();
  });
});

function custom(dimension: string): CustomCardRequest {
  return { kind: "custom", dimension };
}

const ok = (body: unknown): CustomCardAnswer => ({ status: 200, body });

describe("createCustomCardBatcher", () => {
  it("sends every card asked for in one turn in one batch, and hands each its own answer", async () => {
    const send = vi.fn(async (cards: CustomCardRequest[]) =>
      cards.map((c) => ok({ breakdown: [{ value: (c as { dimension: string }).dimension, type: "MOVIE", _count: 1 }] })),
    );
    const batcher = createCustomCardBatcher(send);
    const answers = await Promise.all([batcher.load(custom("genre")), batcher.load(custom("resolution"))]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([custom("genre"), custom("resolution")]);
    expect(answers.map((a) => (a.body as { breakdown: { value: string }[] }).breakdown[0].value)).toEqual([
      "genre",
      "resolution",
    ]);
  });

  it("sends a card asked for twice in a turn once, and answers both", async () => {
    const send = vi.fn(async (cards: CustomCardRequest[]) => cards.map(() => ok({ breakdown: [] })));
    const batcher = createCustomCardBatcher(send);
    const [a, b] = await Promise.all([batcher.load(custom("genre")), batcher.load(custom("genre"))]);
    expect(send.mock.calls[0][0]).toEqual([custom("genre")]);
    expect(a).toEqual(b);
  });

  it("sends a later turn's cards in a batch of their own", async () => {
    const send = vi.fn(async (cards: CustomCardRequest[]) => cards.map(() => ok({ breakdown: [] })));
    const batcher = createCustomCardBatcher(send);
    await batcher.load(custom("genre"));
    await batcher.load(custom("genre"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails only the card whose route failed", async () => {
    const send = vi.fn(async () => [{ status: 500, body: { error: "boom" } }, ok({ breakdown: [] })]);
    const batcher = createCustomCardBatcher(send);
    const [failed, fine] = await Promise.all([batcher.load(custom("a")), batcher.load(custom("b"))]);
    expect(failed.status).toBe(500);
    expect(fine.status).toBe(200);
  });

  it("fails every card of a batch that failed as a whole, or threw", async () => {
    for (const send of [vi.fn(async () => null), vi.fn(async () => { throw new Error("offline"); })]) {
      const batcher = createCustomCardBatcher(send);
      const answers = await Promise.all([batcher.load(custom("a")), batcher.load(custom("b"))]);
      expect(answers).toEqual([{ status: 0, body: null }, { status: 0, body: null }]);
    }
  });

  it("splits more cards than one batch takes into several, each answered", async () => {
    const send = vi.fn(async (cards: CustomCardRequest[]) => cards.map((c) => ok(c)));
    const batcher = createCustomCardBatcher(send);
    const requests = Array.from({ length: CUSTOM_CARD_BATCH_LIMIT + 3 }, (_, i) => custom(`d${i}`));
    const answers = await Promise.all(requests.map((r) => batcher.load(r)));
    expect(send.mock.calls.map((call) => call[0].length)).toEqual([CUSTOM_CARD_BATCH_LIMIT, 3]);
    expect(answers.map((a) => a.body)).toEqual(requests);
  });

  it("uses the batch route's own card limit", () => {
    expect(CUSTOM_CARD_BATCH_LIMIT).toBe(MAX_CUSTOM_STATS_BATCH);
  });
});

describe("postCustomCardBatch", () => {
  it("posts the cards and returns the route's answers in order", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ cards: [{ status: 200, body: { breakdown: [] } }, { status: 400, body: { error: "x" } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const answers = await postCustomCardBatch([custom("a"), custom("b")]);
    expect(answers).toEqual([
      { status: 200, body: { breakdown: [] } },
      { status: 400, body: { error: "x" } },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CUSTOM_CARD_BATCH_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ cards: [custom("a"), custom("b")] });
  });

  it("is null for a refused batch, an answer of the wrong length, or a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Validation failed" }), { status: 400 })));
    expect(await postCustomCardBatch([custom("a")])).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ cards: [] }), { status: 200 })));
    expect(await postCustomCardBatch([custom("a")])).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await postCustomCardBatch([custom("a")])).toBeNull();
  });

  it("reads a malformed entry as a failed card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ cards: [null] }), { status: 200 })));
    expect(await postCustomCardBatch([custom("a")])).toEqual([{ status: 0, body: null }]);
  });
});
