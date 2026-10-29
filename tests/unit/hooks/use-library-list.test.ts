// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  subscribers: [] as { type: string; cb: (data: Record<string, unknown>) => void }[],
}));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: (data: Record<string, unknown>) => void) => {
    mocks.subscribers.push({ type, cb });
    return { connected: true, authExpired: false };
  },
  isRealtimeLive: () => true,
}));

import { useLibraryList, type LibraryListOptions } from "@/hooks/use-library-list";
import { clearLibraryListCache } from "@/lib/media/list-cache";
import { FIRST_CHUNK_SIZE } from "@/lib/media/progressive-load";

interface Item {
  id: string;
}

const item = (n: number): Item => ({ id: `i${n}` });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => item(from + i));

/** Every request waits until the test answers it. */
interface PendingRequest {
  url: string;
  answer: (body: unknown) => void;
  fail: (status?: number) => void;
}
let pending: PendingRequest[] = [];

function stubFetch() {
  pending = [];
  const fn = vi.fn(
    (url: string) =>
      new Promise<Response>((resolve) => {
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

const isFirst = (url: string) => url.includes(`limit=${FIRST_CHUNK_SIZE}`);
const isRest = (url: string) => url.includes("offset=");
const anyRequest = () => true;

/** A sync finishing, as the shell sees it: the list cache dropped, then the page's subscriber. */
function emitSync(data: Record<string, unknown> = {}) {
  clearLibraryListCache();
  act(() => mocks.subscribers.filter((s) => s.type === "sync:completed").at(-1)!.cb(data));
}

type Snapshot = { loading: boolean; loadingRest: boolean; count: number };

function renderList(initial: { query: string; mode?: "progressive" | "grouped" }) {
  const renders: Snapshot[] = [];
  const hook = renderHook(
    ({ query, mode }: { query: string; mode?: "progressive" | "grouped" }) => {
      const options: LibraryListOptions<Item, { things?: Item[] }> =
        mode === "grouped"
          ? {
              url: "/api/things/grouped",
              params: new URLSearchParams(query),
              mode: "grouped",
              select: selectThings,
              syncScope: { types: "MOVIE" },
              debounceMs: 0,
            }
          : {
              url: "/api/things",
              params: new URLSearchParams(query),
              mode: "progressive",
              syncScope: { types: "MOVIE" },
              debounceMs: 0,
            };
      const list = useLibraryList(options);
      renders.push({ loading: list.loading, loadingRest: list.loadingRest, count: list.items.length });
      return list;
    },
    { initialProps: initial },
  );
  return { ...hook, renders };
}

const selectThings = (body: { things?: Item[] }) => body.things;

/** Load the whole progressive list: a full first screenful, then `rest` more. */
async function loadWhole(rest: number) {
  await waitFor(() => expect(pending.some((p) => isFirst(p.url))).toBe(true));
  await answer(isFirst, { items: range(0, FIRST_CHUNK_SIZE), pagination: { hasMore: true } });
  await waitFor(() => expect(pending.some((p) => isRest(p.url))).toBe(true));
  await answer(isRest, { items: range(FIRST_CHUNK_SIZE, FIRST_CHUNK_SIZE + rest) });
}

beforeEach(() => {
  mocks.subscribers = [];
  clearLibraryListCache();
  stubFetch();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useLibraryList — progressive", () => {
  it("paints the first screenful, then the whole list", async () => {
    const { result } = renderList({ query: "sortBy=title" });
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(pending).toHaveLength(1));
    // A first load asks for the rest only once the first screenful answers.
    expect(isFirst(pending[0].url)).toBe(true);
    await answer(isFirst, { items: range(0, FIRST_CHUNK_SIZE), pagination: { hasMore: true } });
    expect(result.current).toMatchObject({ loading: false, loadingRest: true });
    expect(result.current.items).toHaveLength(FIRST_CHUNK_SIZE);

    await waitFor(() => expect(pending.some((p) => isRest(p.url))).toBe(true));
    await answer(isRest, { items: range(FIRST_CHUNK_SIZE, FIRST_CHUNK_SIZE + 5) });
    await waitFor(() => expect(result.current.loadingRest).toBe(false));
    expect(result.current.items).toHaveLength(FIRST_CHUNK_SIZE + 5);
  });

  it("refreshes in place on a sync: no skeleton, no first screenful, both requests at once", async () => {
    const { result, renders } = renderList({ query: "sortBy=title" });
    await loadWhole(5);
    await waitFor(() => expect(result.current.loadingRest).toBe(false));
    const before = renders.length;

    emitSync({ libraryTypes: ["MOVIE"] });
    // The refresh asks for the first screenful and the rest together.
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending.some((p) => isFirst(p.url))).toBe(true);
    expect(pending.some((p) => isRest(p.url))).toBe(true);

    await answer(isFirst, { items: range(0, FIRST_CHUNK_SIZE), pagination: { hasMore: true } });
    // Nothing changes on screen until the whole list is in.
    expect(result.current.items).toHaveLength(FIRST_CHUNK_SIZE + 5);
    await answer(isRest, { items: range(FIRST_CHUNK_SIZE, FIRST_CHUNK_SIZE + 6) });
    await waitFor(() => expect(result.current.items).toHaveLength(FIRST_CHUNK_SIZE + 6));

    const during = renders.slice(before);
    expect(during.every((r) => !r.loading && !r.loadingRest)).toBe(true);
    expect(during.every((r) => r.count >= FIRST_CHUNK_SIZE + 5)).toBe(true);
  });

  it("ignores a sync that cannot have changed the list", async () => {
    renderList({ query: "sortBy=title" });
    await loadWhole(1);
    emitSync({ libraryTypes: ["MUSIC"] });
    await Promise.resolve();
    expect(pending).toHaveLength(0);
  });

  it("keeps the list on screen when a refresh fails", async () => {
    const { result } = renderList({ query: "sortBy=title" });
    await loadWhole(5);
    await waitFor(() => expect(result.current.loadingRest).toBe(false));

    emitSync();
    await waitFor(() => expect(pending).toHaveLength(2));
    await fail(isFirst);
    expect(result.current).toMatchObject({ loading: false, loadingRest: false });
    expect(result.current.items).toHaveLength(FIRST_CHUNK_SIZE + 5);
  });

  it("refreshes a first screenful in place, and a failure there clears the loading flags", async () => {
    const { result, renders } = renderList({ query: "sortBy=title" });
    await waitFor(() => expect(pending).toHaveLength(1));
    await answer(isFirst, { items: range(0, FIRST_CHUNK_SIZE), pagination: { hasMore: true } });
    await waitFor(() => expect(pending.some((p) => isRest(p.url))).toBe(true));
    const before = renders.length;

    // A sync lands while the rest of the library is still loading.
    emitSync();
    // The first load's rest, then the refresh's two requests.
    await waitFor(() => expect(pending).toHaveLength(3));
    // The superseded request's rest answers late and is dropped.
    await answer(isRest, { items: range(FIRST_CHUNK_SIZE, FIRST_CHUNK_SIZE + 99) });
    expect(result.current.items).toHaveLength(FIRST_CHUNK_SIZE);
    await fail(isFirst);

    // Never stuck: the first screenful stays and both flags are off.
    expect(result.current).toMatchObject({ loading: false, loadingRest: false });
    expect(result.current.items).toHaveLength(FIRST_CHUNK_SIZE);
    expect(renders.slice(before).every((r) => !r.loading)).toBe(true);
  });

  it("shows the skeleton for new parameters and empties the list when their load fails", async () => {
    const { result, rerender } = renderList({ query: "sortBy=title" });
    await loadWhole(1);

    rerender({ query: "sortBy=year" });
    await waitFor(() => expect(result.current.loading).toBe(true));
    await waitFor(() => expect(pending).toHaveLength(1));
    await fail(anyRequest);
    // The previous list under the new sort would read as its result.
    expect(result.current).toMatchObject({ loading: false, loadingRest: false });
    expect(result.current.items).toHaveLength(0);
  });

  it("treats going back to the shown parameters behind another skeleton as a load", async () => {
    const { result, rerender } = renderList({ query: "sortBy=title" });
    await loadWhole(1);

    rerender({ query: "sortBy=year" });
    await waitFor(() => expect(pending).toHaveLength(1));
    // Past the cache, which would otherwise hand the title list back at once.
    clearLibraryListCache();
    rerender({ query: "sortBy=title" });
    // Still the skeleton, and the first screenful is asked for on its own.
    await waitFor(() => expect(pending.filter((p) => p.url.includes("sortBy=title"))).toHaveLength(1));
    expect(result.current.loading).toBe(true);
    expect(pending.some((p) => p.url.includes("sortBy=title") && isRest(p.url))).toBe(false);

    // The abandoned request's answer is never applied.
    await answer((url) => url.includes("sortBy=year"), { items: [item(900)], pagination: { hasMore: false } });
    expect(result.current.loading).toBe(true);
    await answer((url) => url.includes("sortBy=title"), { items: [item(1)], pagination: { hasMore: false } });
    expect(result.current.items).toEqual([item(1)]);
  });
});

describe("useLibraryList — grouped", () => {
  it("loads through select and refreshes in place", async () => {
    const { result, renders } = renderList({ query: "limit=0", mode: "grouped" });
    await waitFor(() => expect(pending).toHaveLength(1));
    await answer(anyRequest, { things: [item(1), item(2)] });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current).toMatchObject({ loading: false, loadingRest: false });
    const before = renders.length;

    emitSync();
    await waitFor(() => expect(pending).toHaveLength(1));
    await answer(anyRequest, { things: [item(1), item(2), item(3)] });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(renders.slice(before).every((r) => !r.loading)).toBe(true);
  });

  it("reads a body without the list as an empty one", async () => {
    const { result } = renderList({ query: "limit=0", mode: "grouped" });
    await waitFor(() => expect(pending).toHaveLength(1));
    await answer(anyRequest, {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([]);
  });
});
