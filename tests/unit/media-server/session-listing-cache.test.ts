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
    invalidateSessionListings();
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

  it("remembers a failed fetch for the window, so a dead server is not asked on every poll", async () => {
    const fetchSessions = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue([session("s1")]);
    await expect(getCachedSessionListing("srv", fetchSessions)).rejects.toThrow("ECONNREFUSED");
    await expect(getCachedSessionListing("srv", fetchSessions)).rejects.toThrow(/unreachable/);
    expect(fetchSessions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(API_SESSION_LISTING_TTL_MS + 1);
    expect(await getCachedSessionListing("srv", fetchSessions)).toEqual([session("s1")]);
    expect(fetchSessions).toHaveBeenCalledTimes(2);
  });

  it("drops one server's listing on a termination there and leaves the others", async () => {
    const a = vi.fn().mockResolvedValue([session("a")]);
    const b = vi.fn().mockResolvedValue([session("b")]);
    await getCachedSessionListing("srv-a", a);
    await getCachedSessionListing("srv-b", b);
    invalidateSessionListings("srv-a");
    await getCachedSessionListing("srv-a", a);
    await getCachedSessionListing("srv-b", b);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  // The server still reports a just-stopped stream for a moment; a listing
  // fetched then must not be kept for the whole window.
  it("keeps a server uncached for the window after a termination, then caches again", async () => {
    const fetchSessions = vi.fn().mockResolvedValue([session("s1")]);
    invalidateSessionListings("srv");
    await getCachedSessionListing("srv", fetchSessions);
    await getCachedSessionListing("srv", fetchSessions);
    expect(fetchSessions).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(API_SESSION_LISTING_TTL_MS + 1);
    await getCachedSessionListing("srv", fetchSessions);
    await getCachedSessionListing("srv", fetchSessions);
    expect(fetchSessions).toHaveBeenCalledTimes(3);
  });

  it("clears an unreachable mark on a termination there", async () => {
    const fetchSessions = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue([]);
    await expect(getCachedSessionListing("srv", fetchSessions)).rejects.toThrow("ECONNREFUSED");
    invalidateSessionListings("srv");
    expect(await getCachedSessionListing("srv", fetchSessions)).toEqual([]);
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
