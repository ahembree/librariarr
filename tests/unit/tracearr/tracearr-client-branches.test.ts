import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AxiosError, InternalAxiosRequestConfig } from "axios";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockAxiosInstance, createSpy } = vi.hoisted(() => {
  const instance = {
    get: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  };
  return {
    mockAxiosInstance: instance,
    createSpy: vi.fn(function () {
      return instance;
    }),
  };
});

vi.mock("axios", () => {
  const isAxiosError = (e: unknown) => e instanceof Error && "isAxiosError" in e;
  return { default: { create: createSpy, isAxiosError }, isAxiosError };
});

import { TracearrClient, MAX_PAGE_SIZE } from "@/lib/tracearr/tracearr-client";
import { IntegrationError } from "@/lib/integration-error";
import { logger } from "@/lib/logger";

const HISTORY_URL = "/api/v2/public/history";
const HEALTH = { status: "ok", version: "2.0.0", timestamp: "2026-09-03T12:00:00.000Z", servers: [] };

function axiosFailure(status: number | null, headers: Record<string, string> = {}): AxiosError {
  const error = new Error(
    status === null ? "connect ECONNREFUSED" : `Request failed with status code ${status}`,
  ) as AxiosError;
  error.isAxiosError = true;
  error.code = status === null ? "ECONNREFUSED" : "ERR_BAD_REQUEST";
  error.config = { url: HISTORY_URL, method: "get" } as InternalAxiosRequestConfig;
  error.response =
    status === null
      ? undefined
      : ({ status, data: {}, headers } as unknown as AxiosError["response"]);
  error.toJSON = () => ({});
  return error;
}

function historyBody(records: unknown[], nextCursor: string | null = null) {
  return { data: { data: records, meta: { nextCursor, pageSize: MAX_PAGE_SIZE } } };
}

/** The interceptors the client registered on its axios instance. */
function interceptors() {
  const req = mockAxiosInstance.interceptors.request.use.mock.calls.at(-1)![0] as (
    c: Record<string, unknown>,
  ) => Record<string, unknown>;
  // The client's own error converter is the last response interceptor registered
  // (configureRetry registers one before it).
  const resCall = mockAxiosInstance.interceptors.response.use.mock.calls.at(-1)!;
  return {
    request: req,
    onFulfilled: resCall[0] as (r: unknown) => unknown,
    onRejected: resCall[1] as (e: unknown) => Promise<never>,
  };
}

describe("TracearrClient (branch coverage)", () => {
  let client: TracearrClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    client = new TracearrClient("https://tracearr.example", "k");
  });

  describe("interceptors", () => {
    it("stamps a start time on every request and passes responses through", () => {
      const { request, onFulfilled } = interceptors();
      const cfg = request({ url: "/x" });
      expect(typeof cfg.__startTime).toBe("number");
      const res = { data: 1 };
      expect(onFulfilled(res)).toBe(res);
    });

    it("converts an axios failure into an IntegrationError, logging its duration", async () => {
      const { onRejected } = interceptors();
      const err = axiosFailure(502);
      (err.config as unknown as Record<string, unknown>).__startTime = Date.now() - 5;
      const rejected = await onRejected(err).catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(IntegrationError);
      expect((rejected as IntegrationError).status).toBe(502);
      expect(vi.mocked(logger.debug).mock.calls[0][1]).toMatch(/^ERROR 502 \/api\/v2\/public\/history \(\d+ms\)$/);
    });

    it("logs a network failure without a duration when no start time was stamped", async () => {
      const { onRejected } = interceptors();
      const rejected = await onRejected(axiosFailure(null)).catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(IntegrationError);
      expect(vi.mocked(logger.debug).mock.calls[0][1]).toBe(`ERROR NETWORK ${HISTORY_URL}`);
    });

    it("logs a failure whose config is missing", async () => {
      const { onRejected } = interceptors();
      const err = axiosFailure(500);
      (err as { config?: unknown }).config = undefined;
      const rejected = await onRejected(err).catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(IntegrationError);
      expect(vi.mocked(logger.debug).mock.calls[0][1]).toBe("ERROR 500 undefined");
    });

    it("passes a non-axios failure through unchanged", async () => {
      const { onRejected } = interceptors();
      const plain = new Error("boom");
      await expect(onRejected(plain)).rejects.toBe(plain);
      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  describe("testConnection", () => {
    it("treats a raw (unwrapped) v2 404 as an unknown status, not a version hint", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: HEALTH })
        .mockRejectedValueOnce(axiosFailure(404));
      const r = await client.testConnection();
      expect(r.ok).toBe(false);
      expect(r.error).toBe("Request failed with status code 404");
    });

    it("falls back to a generic message for a non-Error v2 rejection", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: HEALTH })
        .mockRejectedValueOnce("nope");
      await expect(client.testConnection()).resolves.toEqual({ ok: false, error: "Connection failed" });
    });

    it("probes v2 history without transport retries", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: HEALTH })
        .mockResolvedValueOnce(historyBody([]));
      const r = await client.testConnection();
      expect(r).toEqual({ ok: true, version: "2.0.0", serverCount: 0 });
      // Both probes skip the transport retries (NO_RETRY): a Test button
      // reports the first failure instead of waiting out four timeouts.
      expect(mockAxiosInstance.get.mock.calls[0]).toEqual(["/api/v1/public/health", { __noRetry: true }]);
      expect(mockAxiosInstance.get.mock.calls[1]).toEqual([
        HISTORY_URL,
        { params: { pageSize: 1 }, signal: undefined, __noRetry: true },
      ]);
    });
  });

  describe("getHistoryForItem", () => {
    it("asks by a trimmed TMDB id when there is no rating key", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([{ id: "a" }]));
      const r = await client.getHistoryForItem("srv", { tmdbId: " 603 ", imdbId: "tt1" });
      expect(r).toEqual([{ id: "a" }]);
      expect(mockAxiosInstance.get.mock.calls[0][1].params).toEqual({
        server_id: "srv",
        tmdb_id: "603",
        pageSize: MAX_PAGE_SIZE,
      });
    });

    it("asks by a trimmed IMDB id when there is neither rating key nor TMDB id", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([]));
      await client.getHistoryForItem("srv", { tmdbId: null, imdbId: " tt0133093 " });
      expect(mockAxiosInstance.get.mock.calls[0][1].params).toMatchObject({ imdb_id: "tt0133093" });
    });

    it("asks nothing for a blank IMDB id", async () => {
      expect(await client.getHistoryForItem("srv", { imdbId: "   " })).toEqual([]);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it("issues nothing when already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      expect(await client.getHistoryForItem("srv", { ratingKey: "1" }, { signal: ac.signal })).toEqual([]);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it("sends the cursor on later pages and stops on a repeated cursor", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(historyBody([{ id: "1" }], "c1"))
        .mockResolvedValueOnce(historyBody([{ id: "2" }], "c1"));
      const r = await client.getHistoryForItem("srv", { ratingKey: "9" });
      expect(r.map((x) => x.id)).toEqual(["1", "2"]);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(mockAxiosInstance.get.mock.calls[1][1].params.cursor).toBe("c1");
    });

    it("refuses a non-history response", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: "<html>login</html>" });
      await expect(client.getHistoryForItem("srv", { ratingKey: "9" })).rejects.toThrow(
        /unexpected response to a history request/,
      );
    });
  });

  describe("rate-limit retry edges", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not retry a 429 when the signal is already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      const err = new IntegrationError("Tracearr", axiosFailure(429));
      mockAxiosInstance.get.mockRejectedValueOnce(err);
      await expect(client.getHistoryPage("srv", { signal: ac.signal })).rejects.toBe(err);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("treats a non-axios, non-integration failure as a hard error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new TypeError("bad"));
      await expect(client.getHistoryPage("srv")).rejects.toThrow("bad");
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it("reads Retry-After off a raw axios 429 too", async () => {
      vi.useFakeTimers();
      mockAxiosInstance.get
        .mockRejectedValueOnce(axiosFailure(429, { "retry-after": "2" }))
        .mockResolvedValueOnce(historyBody([]));
      const p = client.getHistoryPage("srv");
      await vi.advanceTimersByTimeAsync(1_999);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    it("waits the fallback when an IntegrationError has a non-axios cause", async () => {
      vi.useFakeTimers();
      const err = new IntegrationError("Tracearr", axiosFailure(429));
      Object.defineProperty(err, "cause", { value: "not axios" });
      mockAxiosInstance.get.mockRejectedValueOnce(err).mockResolvedValueOnce(historyBody([]));
      const p = client.getHistoryPage("srv");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });
  });

  describe("findOldestPlayAt", () => {
    it("returns null when the newest play's start time is unparseable", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([{ started_at: "not a date" }]));
      expect(await client.findOldestPlayAt("srv")).toBeNull();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });
  });

  describe("getServerAccountNames", () => {
    it("returns nothing and asks nothing when already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      const names = await client.getServerAccountNames("srv", { signal: ac.signal });
      expect(names.size).toBe(0);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it("skips malformed identities and accounts, and follows the cursor", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: {
            data: [
              null,
              { accounts: null },
              {
                accounts: [
                  null,
                  { server_id: "srv", server_user_id: "", username: "x" },
                  { server_id: "srv", server_user_id: "u1", username: "" },
                  { server_id: "srv", server_user_id: "u2", username: "bob" },
                ],
              },
            ],
            meta: { nextCursor: "n1", pageSize: MAX_PAGE_SIZE },
          },
        })
        .mockResolvedValueOnce({
          data: {
            data: [{ accounts: [{ server_id: "srv", server_user_id: "u3", username: "carol" }] }],
            meta: { nextCursor: null, pageSize: MAX_PAGE_SIZE },
          },
        });
      const names = await client.getServerAccountNames("srv");
      expect([...names.entries()]).toEqual([["u2", "bob"], ["u3", "carol"]]);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(mockAxiosInstance.get.mock.calls[0][1].params).toEqual({ pageSize: MAX_PAGE_SIZE, include_removed: "true" });
      expect(mockAxiosInstance.get.mock.calls[1][1].params).toEqual({
        pageSize: MAX_PAGE_SIZE,
        include_removed: "true",
        cursor: "n1",
      });
    });

    // A walk cut short must hand back NO names, never the part it read: the
    // importer refuses to write on an empty map, but a partial one passes that
    // gate and every unread user's plays land under Tracearr's identity label
    // for good.
    function usersPage(names: Array<[string, string]>, nextCursor: string | null) {
      return {
        data: {
          data: [
            {
              accounts: names.map(([id, username]) => ({
                server_id: "srv",
                server_user_id: id,
                username,
              })),
            },
          ],
          meta: { nextCursor, pageSize: MAX_PAGE_SIZE },
        },
      };
    }

    it("returns no names when the cursor repeats", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(usersPage([["u1", "alice"]], "same"))
        .mockResolvedValueOnce(usersPage([["u2", "bob"]], "same"));
      const names = await client.getServerAccountNames("srv");
      expect(names.size).toBe(0);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(vi.mocked(logger.warn).mock.calls[0][1]).toMatch(/repeated cursor/);
    });

    it("returns no names when a later page carries no data array", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(usersPage([["u1", "alice"]], "n1"))
        .mockResolvedValueOnce({ data: { meta: { nextCursor: null, pageSize: MAX_PAGE_SIZE } } });
      const names = await client.getServerAccountNames("srv");
      expect(names.size).toBe(0);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    it("returns no names when the page cap cuts a walk that still has pages", async () => {
      let call = 0;
      mockAxiosInstance.get.mockImplementation(async () => {
        call++;
        return usersPage([[`u${call}`, `user${call}`]], `c${call}`);
      });
      const names = await client.getServerAccountNames("srv");
      expect(names.size).toBe(0);
      // The cap is a runaway guard: it stops asking, and says why.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(50);
      expect(vi.mocked(logger.warn).mock.calls[0][1]).toMatch(/50-page cap/);
    });

    it("returns no names when aborted part-way through the walk", async () => {
      const ac = new AbortController();
      mockAxiosInstance.get.mockImplementationOnce(async () => {
        ac.abort();
        return usersPage([["u1", "alice"]], "n1");
      });
      const names = await client.getServerAccountNames("srv", { signal: ac.signal });
      expect(names.size).toBe(0);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it("returns every page's names when the walk reaches the end", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(usersPage([["u1", "alice"]], "n1"))
        .mockResolvedValueOnce(usersPage([["u2", "bob"]], null));
      const names = await client.getServerAccountNames("srv");
      expect([...names.entries()]).toEqual([["u1", "alice"], ["u2", "bob"]]);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
