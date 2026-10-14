import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appCache } from "@/lib/cache/memory-cache";
import {
  API_SESSION_LISTING_TTL_MS,
  getCachedSessionListing,
  invalidateSessionListings,
} from "@/lib/media-server/session-listing-cache";
import type { MediaSession } from "@/lib/media-server/types";

const session = (id: string): MediaSession =>
  ({ sessionId: id, userId: "u1", username: "alice", title: "Arrival", type: "movie" }) as unknown as MediaSession;

describe("session listing cache", () => {
  beforeEach(() => {
    appCache.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks a server once within the TTL, and again once it has passed", async () => {
    const fetchSessions = vi.fn().mockResolvedValue([session("s1")]);
    expect(await getCachedSessionListing("srv", fetchSessions)).toEqual([session("s1")]);
    expect(await getCachedSessionListing("srv", fetchSessions)).toEqual([session("s1")]);
    expect(fetchSessions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(API_SESSION_LISTING_TTL_MS + 1);
    fetchSessions.mockResolvedValue([session("s2")]);
    expect(await getCachedSessionListing("srv", fetchSessions)).toEqual([session("s2")]);
    expect(fetchSessions).toHaveBeenCalledTimes(2);
  });

  it("keeps one listing per server", async () => {
    const a = vi.fn().mockResolvedValue([session("a")]);
    const b = vi.fn().mockResolvedValue([session("b")]);
    expect(await getCachedSessionListing("srv-a", a)).toEqual([session("a")]);
    expect(await getCachedSessionListing("srv-b", b)).toEqual([session("b")]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("never keeps a failed fetch — an unreachable server is asked again", async () => {
    const fetchSessions = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue([session("s1")]);
    await expect(getCachedSessionListing("srv", fetchSessions)).rejects.toThrow("ECONNREFUSED");
    expect(await getCachedSessionListing("srv", fetchSessions)).toEqual([session("s1")]);
    expect(fetchSessions).toHaveBeenCalledTimes(2);
  });

  it("is dropped by invalidateSessionListings, for every server", async () => {
    const a = vi.fn().mockResolvedValue([session("a")]);
    const b = vi.fn().mockResolvedValue([session("b")]);
    await getCachedSessionListing("srv-a", a);
    await getCachedSessionListing("srv-b", b);
    invalidateSessionListings();
    await getCachedSessionListing("srv-a", a);
    await getCachedSessionListing("srv-b", b);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
