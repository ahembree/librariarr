// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  subscribers: [] as { type: string; cb: (data: Record<string, unknown>) => void }[],
  // Whether pushes arrive: with them off, every cached list counts as past fresh.
  live: true,
}));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: (data: Record<string, unknown>) => void) => {
    mocks.subscribers.push({ type, cb });
    return { connected: true, authExpired: false };
  },
  isRealtimeLive: () => mocks.live,
}));

import { useLibraryList } from "@/hooks/use-library-list";
import { clearLibraryListCache } from "@/lib/media/list-cache";
import { LIST_PAGE_SIZE, MAX_PAGES_IN_FLIGHT } from "@/lib/media/paged-list";

interface Item {
  id: string;
}

const item = (n: number, tag = ""): Item => ({ id: `i${n}${tag}` });
const rows = (from: number, to: number, tag = "") => Array.from({ length: to - from }, (_, i) => item(from + i, tag));

/** Every request waits until the test answers it. */
interface PendingRequest {
  url: string;
  answer: (body: unknown) => void;
  fail: (status?: number) => void;
}
let pending: PendingRequest[] = [];
let requested: string[] = [];

function stubFetch() {
  pending = [];
  requested = [];
  const fn = vi.fn(
    (url: string) =>
      new Promise<Response>((resolve) => {
        requested.push(url);
        pending.push({
          url,
          answer: (body) => resolve({ ok: true, status: 200, json: async () => body } as Response),
          fail: (status = 500) => resolve({ ok: false, status, json: async () => ({}) } as Response),
        });
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const offsetOf = (url: string) => Number(new URL(url, "http://x").searchParams.get("offset"));
const pageOf = (page: number) => (url: string) => offsetOf(url) === page * LIST_PAGE_SIZE;
const withQuery = (query: string) => (url: string) => url.includes(query);

/** Answer the oldest waiting request whose URL passes `match`, and let React settle. */
async function answer(match: (url: string) => boolean, body: unknown) {
  const index = pending.findIndex((p) => match(p.url));
  expect(index, `no pending request matching ${match}`).toBeGreaterThanOrEqual(0);
  const [request] = pending.splice(index, 1);
  await act(async () => {
    request.answer(body);
  });
}

async function fail(match: (url: string) => boolean) {
  const index = pending.findIndex((p) => match(p.url));
  expect(index).toBeGreaterThanOrEqual(0);
  const [request] = pending.splice(index, 1);
  await act(async () => {
    request.fail();
  });
}

/** A page of a listing of `total` rows, as the routes answer it. */
function pageBody(page: number, total: number, tag = "") {
  const from = page * LIST_PAGE_SIZE;
  const to = Math.min(total, from + LIST_PAGE_SIZE);
  return {
    things: rows(from, to, tag),
    pagination: { page: 1, limit: LIST_PAGE_SIZE, hasMore: to < total },
    ...(page === 0 && { index: { total, letters: { A: 0 } } }),
  };
}

/** A sync finishing, as the shell sees it: the list cache dropped, then the page's subscriber. */
function emitSync(data: Record<string, unknown> = {}) {
  clearLibraryListCache();
  act(() => mocks.subscribers.filter((s) => s.type === "sync:completed").at(-1)!.cb(data));
}

const selectThings = (body: { things?: Item[] }) => body.things;

function renderList(initial: { query: string }) {
  const renders: { loading: boolean; count: number }[] = [];
  const hook = renderHook(
    ({ query }: { query: string }) => {
      const list = useLibraryList({
        url: "/api/things",
        params: new URLSearchParams(query),
        select: selectThings,
        syncScope: { types: "MOVIE" },
        debounceMs: 0,
      });
      renders.push({ loading: list.loading, count: list.items.length });
      return list;
    },
    { initialProps: initial },
  );
  return { ...hook, renders };
}

/** Let the first fetch (a microtask) and any debounce go out. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mocks.subscribers = [];
  mocks.live = true;
  clearLibraryListCache();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLibraryList", () => {
  it("reads the first page with the listing's index, and sizes the list by it", async () => {
    const { result } = renderList({ query: "sortBy=title&limit=0&offset=7" });
    expect(result.current.loading).toBe(true);
    await settle();

    expect(requested).toHaveLength(1);
    const first = new URL(requested[0], "http://x").searchParams;
    // The page's own paging, whatever the params carried — never `limit=0`.
    expect(first.get("limit")).toBe(String(LIST_PAGE_SIZE));
    expect(first.get("offset")).toBe("0");
    expect(first.get("index")).toBe("1");
    expect(first.get("sortBy")).toBe("title");

    await answer(pageOf(0), pageBody(0, 1234));
    expect(result.current.loading).toBe(false);
    expect(result.current.index).toEqual({ total: 1234, letters: { A: 0 } });
    expect(result.current.items).toHaveLength(1234);
    expect(result.current.items[99]).toEqual(item(99));
    // The rows past the first page are placeholders until read.
    expect(result.current.items[100]).toBeUndefined();
  });

  it("reads the pages holding the range on screen, and the lookahead around it, once each", async () => {
    const { result } = renderList({ query: "sortBy=title" });
    await settle();
    await answer(pageOf(0), pageBody(0, 1000));

    act(() => result.current.requestRange(220, 260));
    // Rows 170–310: pages 1, 2 and 3.
    expect(pending.map((p) => offsetOf(p.url)).sort((a, b) => a - b)).toEqual([100, 200, 300]);
    for (const url of requested.slice(1)) {
      expect(new URL(url, "http://x").searchParams.get("index")).toBeNull();
      expect(new URL(url, "http://x").searchParams.get("limit")).toBe(String(LIST_PAGE_SIZE));
    }

    await answer(pageOf(2), pageBody(2, 1000));
    expect(result.current.items[250]).toEqual(item(250));
    expect(result.current.items[150]).toBeUndefined();

    // The same range again asks for nothing new.
    act(() => result.current.requestRange(221, 261));
    expect(requested).toHaveLength(4);
  });

  it("keeps at most a few pages in flight, then reads what the range on screen needs now", async () => {
    const { result } = renderList({ query: "" });
    await settle();
    await answer(pageOf(0), pageBody(0, 100_000));

    act(() => result.current.requestRange(1000, 1600));
    expect(pending).toHaveLength(MAX_PAGES_IN_FLIGHT);
    // A fling far past them: nothing more goes out until one finishes…
    act(() => result.current.requestRange(50_000, 50_040));
    expect(pending).toHaveLength(MAX_PAGES_IN_FLIGHT);
    // …and then only the pages the range on screen now needs.
    await answer(pageOf(9), pageBody(9, 100_000));
    expect(offsetOf(pending.at(-1)!.url)).toBe(49_900);
  });

  it("leaves a failed page a placeholder, and asks again once the range moves", async () => {
    const { result } = renderList({ query: "" });
    await settle();
    await answer(pageOf(0), pageBody(0, 500));

    act(() => result.current.requestRange(310, 320));
    await fail(pageOf(3));
    expect(result.current.items[315]).toBeUndefined();
    expect(pending.filter((p) => pageOf(3)(p.url))).toHaveLength(0);

    act(() => result.current.requestRange(311, 321));
    await answer(pageOf(3), pageBody(3, 500));
    expect(result.current.items[315]).toEqual(item(315));
  });

  it("shows the skeleton for new parameters, and never applies the old ones' answers", async () => {
    const { result, rerender, renders } = renderList({ query: "genre=a" });
    await settle();
    await answer(withQuery("genre=a"), pageBody(0, 300));
    act(() => result.current.requestRange(150, 160));

    rerender({ query: "genre=b" });
    await settle();
    expect(result.current.loading).toBe(true);
    // The old listing's page arrives late: dropped.
    await answer(withQuery("genre=a"), pageBody(1, 300, "-old"));
    expect(result.current.loading).toBe(true);

    await answer(withQuery("genre=b"), pageBody(0, 40, "-b"));
    expect(result.current.loading).toBe(false);
    expect(result.current.items).toEqual(rows(0, 40, "-b"));
    expect(renders.every((r) => r.count === 0 || r.count === 300 || r.count === 40)).toBe(true);
  });

  it("refreshes in place after a sync: no skeleton, the rows kept until each page is read again", async () => {
    const { result, renders } = renderList({ query: "" });
    await settle();
    await answer(pageOf(0), pageBody(0, 250));
    act(() => result.current.requestRange(0, 249));
    await answer(pageOf(1), pageBody(1, 250));
    await answer(pageOf(2), pageBody(2, 250));
    const before = renders.length;

    emitSync({ libraryTypes: ["MOVIE"] });
    await settle();
    expect(pending.map((p) => offsetOf(p.url))).toEqual([0]);
    expect(new URL(pending[0].url, "http://x").searchParams.get("index")).toBe("1");

    // One new row: the list grows, page 0 is the new one, and the rows of the
    // pages not read again yet stay on screen until they are.
    await answer(pageOf(0), pageBody(0, 251, "-new"));
    expect(result.current.items).toHaveLength(251);
    expect(result.current.items[0]).toEqual(item(0, "-new"));
    expect(result.current.items[150]).toEqual(item(150));
    // The pages in range are read again.
    expect(pending.map((p) => offsetOf(p.url)).sort((a, b) => a - b)).toEqual([100, 200]);
    await answer(pageOf(1), pageBody(1, 251, "-new"));
    expect(result.current.items[150]).toEqual(item(150, "-new"));

    expect(renders.slice(before).every((r) => !r.loading)).toBe(true);
  });

  it("drops rows past a list that shrank on refresh", async () => {
    const { result } = renderList({ query: "" });
    await settle();
    await answer(pageOf(0), pageBody(0, 150));
    act(() => result.current.requestRange(100, 149));
    await answer(pageOf(1), pageBody(1, 150));

    emitSync({ libraryTypes: ["MOVIE"] });
    await settle();
    await answer(pageOf(0), pageBody(0, 120));
    expect(result.current.items).toHaveLength(120);
    expect(result.current.items[119]).toEqual(item(119));
  });

  it("keeps the list when a refresh fails, and shows none when new parameters fail", async () => {
    const { result, rerender } = renderList({ query: "a=1" });
    await settle();
    await answer(pageOf(0), pageBody(0, 30));

    emitSync({ libraryTypes: ["MOVIE"] });
    await settle();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await fail(pageOf(0));
    expect(result.current.items).toHaveLength(30);
    expect(result.current.loading).toBe(false);

    rerender({ query: "a=2" });
    await settle();
    await fail(withQuery("a=2"));
    expect(result.current.loading).toBe(false);
    expect(result.current.items).toHaveLength(0);
    vi.mocked(console.error).mockRestore();
  });

  it("paints a listing read in the last minute at once — every page read — and asks for nothing", async () => {
    const first = renderList({ query: "s=1" });
    await settle();
    await answer(pageOf(0), pageBody(0, 400));
    act(() => first.result.current.requestRange(220, 230));
    await answer(pageOf(2), pageBody(2, 400));
    await answer(pageOf(1), pageBody(1, 400));
    first.unmount();
    const before = requested.length;

    const again = renderList({ query: "s=1" });
    expect(again.result.current.loading).toBe(true);
    await settle();
    expect(again.result.current.loading).toBe(false);
    expect(again.result.current.items[250]).toEqual(item(250));
    expect(requested).toHaveLength(before);
  });

  it("shows a listing past fresh at once and refreshes it behind", async () => {
    const first = renderList({ query: "s=1" });
    await settle();
    await answer(pageOf(0), pageBody(0, 50));
    first.unmount();

    mocks.live = false;
    const again = renderList({ query: "s=1" });
    await settle();
    expect(again.result.current.items).toHaveLength(50);
    expect(again.result.current.loading).toBe(false);
    expect(pending.map((p) => offsetOf(p.url))).toEqual([0]);
    await answer(pageOf(0), pageBody(0, 51, "-new"));
    expect(again.result.current.items).toHaveLength(51);
  });

  it("answers its refetch once the first page is in", async () => {
    const { result } = renderList({ query: "" });
    await settle();
    await answer(pageOf(0), pageBody(0, 10));
    let done = false;
    act(() => {
      void result.current.refetch().then(() => {
        done = true;
      });
    });
    expect(done).toBe(false);
    await answer(pageOf(0), pageBody(0, 11));
    expect(done).toBe(true);
    expect(result.current.items).toHaveLength(11);
  });
});
