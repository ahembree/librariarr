import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AxiosError } from "axios";

vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { IntegrationError } from "@/lib/integration-error";
import {
  DELETE_CONFIRM_INTERVAL_MS,
  DELETE_CONFIRM_TIMEOUT_MS,
  DELETE_STALL_TIMEOUT_MS,
  deleteFilesConfirmed,
  isUnansweredWrite,
} from "@/lib/lifecycle/confirmed-delete";

function sonarrError(code: string, status: number | null = null): IntegrationError {
  return new IntegrationError("Sonarr", {
    isAxiosError: true,
    name: "AxiosError",
    message: "x",
    code,
    config: { url: "/api/v3/episodefile/bulk", method: "delete" },
    response: status === null ? undefined : { status, data: {} },
    toJSON: () => ({}),
  } as unknown as AxiosError);
}

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

describe("isUnansweredWrite", () => {
  it("is a timeout or a gateway timeout, nothing else", () => {
    expect(isUnansweredWrite(sonarrError("ECONNABORTED"))).toBe(true);
    expect(isUnansweredWrite(sonarrError("ETIMEDOUT"))).toBe(true);
    expect(isUnansweredWrite(sonarrError("ERR_BAD_RESPONSE", 504))).toBe(true);
    // Cloudflare gives up on the origin at 100 s; a proxy may cut or fail the request.
    expect(isUnansweredWrite(sonarrError("ERR_BAD_RESPONSE", 524))).toBe(true);
    expect(isUnansweredWrite(sonarrError("ERR_BAD_RESPONSE", 502))).toBe(true);
    expect(isUnansweredWrite(sonarrError("ECONNRESET"))).toBe(true);
    expect(isUnansweredWrite(sonarrError("ECONNREFUSED"))).toBe(false);
    expect(isUnansweredWrite(sonarrError("ERR_BAD_RESPONSE", 500))).toBe(false);
    expect(isUnansweredWrite(new Error("timeout"))).toBe(false);
  });
});

describe("deleteFilesConfirmed", () => {
  let present: Set<number>;
  const stillPresent = vi.fn(async () => new Set(present));

  beforeEach(() => {
    vi.useFakeTimers();
    stillPresent.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes a chunk at a time", async () => {
    const remove = vi.fn(async (chunk: number[]) => void chunk);
    await deleteFilesConfirmed({ app: "Sonarr", what: "episode file", fileIds: ids(60), remove, stillPresent, chunkSize: 25 });
    expect(remove.mock.calls.map(([chunk]) => chunk.length)).toEqual([25, 25, 10]);
    expect(remove.mock.calls.flatMap(([chunk]) => chunk)).toEqual(ids(60));
    expect(stillPresent).not.toHaveBeenCalled();
  });

  it("counts a timed-out chunk as deleted once the app no longer has its files, and goes on", async () => {
    present = new Set(ids(3));
    const remove = vi.fn(async (chunk: number[]) => {
      if (chunk[0] === 1) throw sonarrError("ECONNABORTED");
    });
    const done = deleteFilesConfirmed({ app: "Sonarr", what: "episode file", fileIds: ids(4), remove, stillPresent, chunkSize: 2 });
    // Still moving files into the recycle bin at the first look; done at the second.
    await vi.advanceTimersByTimeAsync(DELETE_CONFIRM_INTERVAL_MS);
    present = new Set([3]);
    await vi.advanceTimersByTimeAsync(DELETE_CONFIRM_INTERVAL_MS);
    await expect(done).resolves.toBeUndefined();
    expect(stillPresent).toHaveBeenCalledTimes(2);
    // Never re-sent; the next chunk went after the confirmation.
    expect(remove.mock.calls.map(([chunk]) => chunk)).toEqual([[1, 2], [3, 4]]);
  });

  it("keeps waiting through a read that fails while the app is busy", async () => {
    present = new Set();
    stillPresent.mockRejectedValueOnce(sonarrError("ECONNABORTED"));
    const remove = vi.fn(async () => {
      throw sonarrError("ERR_BAD_RESPONSE", 504);
    });
    const done = deleteFilesConfirmed({ app: "Sonarr", what: "episode file", fileIds: [7], remove, stillPresent });
    await vi.advanceTimersByTimeAsync(2 * DELETE_CONFIRM_INTERVAL_MS);
    await expect(done).resolves.toBeUndefined();
  });

  it("fails once no file has gone for the stall window, saying how far it got", async () => {
    present = new Set([3, 4]);
    const remove = vi.fn(async (chunk: number[]) => {
      if (chunk[0] === 3) throw sonarrError("ECONNABORTED");
    });
    const done = deleteFilesConfirmed({ app: "Sonarr", what: "episode file", fileIds: ids(4), remove, stillPresent, chunkSize: 2 });
    const failed = expect(done).rejects.toThrow(
      /^Sonarr stopped deleting with 2 of 2 episode file\(s\) left — none went for 5 minutes \(2 of 4 deleted before\)/,
    );
    await vi.advanceTimersByTimeAsync(DELETE_STALL_TIMEOUT_MS + DELETE_CONFIRM_INTERVAL_MS);
    await failed;
  });

  it("keeps waiting while files keep going, however slowly, up to the overall cap", async () => {
    present = new Set(ids(4));
    const remove = vi.fn(async () => {
      throw sonarrError("ECONNABORTED");
    });
    const done = deleteFilesConfirmed({ app: "Sonarr", what: "episode file", fileIds: ids(4), remove, stillPresent });
    let settled = false;
    void done.then(() => { settled = true; }, () => { settled = true; });
    // One file every 4 minutes: slower than the stall window would allow in
    // total, but never 5 minutes without one going.
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(settled).toBe(false);
      present = new Set(ids(4 - i, i + 1));
    }
    await vi.advanceTimersByTimeAsync(DELETE_CONFIRM_INTERVAL_MS);
    await expect(done).resolves.toBeUndefined();
  });

  it("gives up at the overall cap even while files still trickle out", async () => {
    let left = 25;
    present = new Set(ids(left));
    // One of the chunk's files goes every 4 minutes: 100 minutes for all 25.
    const trickle = setInterval(() => {
      left = Math.max(1, left - 1);
      present = new Set(ids(left, 26 - left));
    }, 4 * 60_000);
    const remove = vi.fn(async () => {
      throw sonarrError("ECONNABORTED");
    });
    const done = deleteFilesConfirmed({ app: "Sonarr", what: "episode file", fileIds: ids(25), remove, stillPresent });
    const failed = expect(done).rejects.toThrow(/^Sonarr had not finished deleting \d+ of 25 episode file\(s\) after 60 minutes/);
    await vi.advanceTimersByTimeAsync(DELETE_CONFIRM_TIMEOUT_MS + DELETE_CONFIRM_INTERVAL_MS);
    await failed;
    clearInterval(trickle);
  });

  it("stops waiting at once when the app is gone, failing with the host's error", async () => {
    const hostDown = sonarrError("ECONNREFUSED");
    stillPresent.mockRejectedValueOnce(hostDown);
    const remove = vi.fn(async () => {
      throw sonarrError("ECONNABORTED");
    });
    const done = deleteFilesConfirmed({ app: "Sonarr", what: "episode file", fileIds: [1], remove, stillPresent });
    const failed = expect(done).rejects.toBe(hostDown);
    await vi.advanceTimersByTimeAsync(DELETE_CONFIRM_INTERVAL_MS);
    await failed;
    expect(stillPresent).toHaveBeenCalledTimes(1);
  });

  it("reports how many files are gone after each chunk, and when it waits on the app", async () => {
    present = new Set();
    const remove = vi.fn(async (chunk: number[]) => {
      if (chunk[0] === 3) throw sonarrError("ECONNABORTED");
    });
    const onProgress = vi.fn();
    const done = deleteFilesConfirmed({
      app: "Sonarr", what: "episode file", fileIds: ids(5), remove, stillPresent, chunkSize: 2, onProgress,
    });
    await vi.advanceTimersByTimeAsync(DELETE_CONFIRM_INTERVAL_MS);
    await done;
    expect(onProgress.mock.calls.map(([p]) => [p.deleted, p.waiting])).toEqual([
      [0, false], [2, false], [2, true], [4, false], [5, false],
    ]);
    expect(onProgress).toHaveBeenCalledWith({ app: "Sonarr", deleted: 4, total: 5, waiting: false });
  });

  it("rethrows any other failure as it is", async () => {
    const refused = sonarrError("ERR_BAD_RESPONSE", 500);
    const remove = vi.fn(async () => {
      throw refused;
    });
    await expect(
      deleteFilesConfirmed({ app: "Sonarr", what: "episode file", fileIds: [1], remove, stillPresent }),
    ).rejects.toBe(refused);
    expect(stillPresent).not.toHaveBeenCalled();
  });
});
