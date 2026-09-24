import { describe, it, expect, vi } from "vitest";
import type { AxiosError } from "axios";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { walkSeerrRequests, SEERR_MAX_REQUEST_PAGES } from "@/lib/seerr/request-walk";
import { IntegrationError } from "@/lib/integration-error";
import type { SeerrClient, SeerrRequest } from "@/lib/seerr/seerr-client";

type Params = { take: number; skip: number; mediaType?: string };

function req(id: number, type: "movie" | "tv" = "movie"): SeerrRequest {
  return { id, type, media: { tmdbId: id } } as unknown as SeerrRequest;
}

/** A client over a newest-first list whose contents `mutate` can change between pages. */
function listClient(initial: SeerrRequest[], mutate?: (list: SeerrRequest[], call: number) => void) {
  const list = [...initial];
  let call = 0;
  const getRequests = vi.fn(async ({ take, skip }: Params) => {
    mutate?.(list, call++);
    return { pageInfo: { page: 1, pages: 1, results: list.length }, results: list.slice(skip, skip + take) };
  });
  return { client: { getRequests } as unknown as SeerrClient, getRequests };
}

const newestFirst = (n: number) => Array.from({ length: n }, (_, i) => req(n - i));

describe("walkSeerrRequests", () => {
  it("visits every request exactly once across overlapping pages", async () => {
    const { client, getRequests } = listClient(newestFirst(250));
    const seen: number[] = [];
    await walkSeerrRequests(client, { instanceName: "S" }, (r) => seen.push(r.id));
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(getRequests.mock.calls.map((c) => c[0].skip)).toEqual([0, 90, 180]);
  });

  it("does not double-count a row pushed down by a request created mid-walk", async () => {
    const { client } = listClient(newestFirst(150), (list, call) => {
      if (call === 1) list.unshift(req(9999)); // new request lands at offset 0
    });
    const seen: number[] = [];
    await walkSeerrRequests(client, { instanceName: "S" }, (r) => seen.push(r.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(150); // the new one sits before the offset — next run picks it up
  });

  it("still reads every row when a few already-read requests are deleted mid-walk", async () => {
    const { client } = listClient(newestFirst(250), (list, call) => {
      if (call === 1) list.splice(0, 3); // three rows from page 1 cancelled
    });
    const seen = new Set<number>();
    await walkSeerrRequests(client, { instanceName: "S" }, (r) => seen.add(r.id));
    for (let id = 1; id <= 247; id++) expect(seen.has(id)).toBe(true);
  });

  it("throws when more rows vanish than the overlap can absorb", async () => {
    // A skipped row would read as "never requested" — fail closed instead.
    const { client } = listClient(newestFirst(250), (list, call) => {
      if (call === 1) list.splice(0, 15);
    });
    await expect(walkSeerrRequests(client, { instanceName: "S" }, () => {})).rejects.toThrow(/changed while it was being read/);
  });

  it("throws when the server ignores the offset", async () => {
    const page = newestFirst(100);
    const client = {
      getRequests: vi.fn(async () => ({ pageInfo: { page: 1, pages: 9, results: 900 }, results: page })),
    } as unknown as SeerrClient;
    await expect(walkSeerrRequests(client, { instanceName: "S" }, () => {})).rejects.toThrow(/not advancing/);
  });

  it("throws at the page cap instead of returning a truncated walk", async () => {
    const client = {
      // An endless newest-first list: every page is full and advances.
      getRequests: vi.fn(async ({ skip }: Params) => ({
        results: Array.from({ length: 100 }, (_, i) => req(10_000_000 - skip - i)),
      })),
    } as unknown as SeerrClient;
    await expect(walkSeerrRequests(client, { instanceName: "S" }, () => {})).rejects.toThrow(
      new RegExp(`exceeded ${SEERR_MAX_REQUEST_PAGES} pages`),
    );
  });

  it("throws on a response without a results array", async () => {
    const client = { getRequests: vi.fn(async () => "<html>login</html>") } as unknown as SeerrClient;
    await expect(walkSeerrRequests(client, { instanceName: "S" }, () => {})).rejects.toThrow(/unexpected response/);
  });

  it("filters by type client-side and falls back when the server rejects mediaType", async () => {
    const list = [req(3, "tv"), req(2, "movie"), req(1, "tv")];
    const getRequests = vi.fn(async ({ mediaType, take, skip }: Params) => {
      if (mediaType) {
        const axiosError = Object.assign(new Error("400"), {
          isAxiosError: true,
          config: { url: "/api/v1/request" },
          response: { status: 400, data: { message: "Unknown query parameter 'mediaType'" } },
        }) as unknown as AxiosError;
        throw new IntegrationError("Seerr", axiosError);
      }
      return { results: list.slice(skip, skip + take) };
    });
    const seen: number[] = [];
    await walkSeerrRequests(
      { getRequests } as unknown as SeerrClient,
      { instanceName: "S", mediaType: "tv" },
      (r) => seen.push(r.id),
    );
    expect(seen).toEqual([3, 1]);
    expect(getRequests).toHaveBeenCalledTimes(2);
    expect(getRequests.mock.calls[1][0]).toEqual({ take: 100, skip: 0 });
  });

  it("sends mediaType to servers that accept it", async () => {
    const { client, getRequests } = listClient([req(1, "movie")]);
    await walkSeerrRequests(client, { instanceName: "S", mediaType: "movie" }, () => {});
    expect(getRequests).toHaveBeenCalledWith({ take: 100, skip: 0, mediaType: "movie" });
  });

  it("propagates other errors", async () => {
    const client = { getRequests: vi.fn(async () => { throw new Error("boom"); }) } as unknown as SeerrClient;
    await expect(walkSeerrRequests(client, { instanceName: "S", mediaType: "movie" }, () => {})).rejects.toThrow("boom");
  });
});
