import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  markUnreachable,
  isUnreachable,
  clearUnreachable,
  getLastFailureMessage,
  ServerUnreachableError,
  _resetForTesting,
} from "@/lib/media-server/health-cache";

const FAILURE_TTL_MS = 45_000;

describe("health-cache circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
    vi.useRealTimers();
  });

  describe("markUnreachable / isUnreachable", () => {
    it("reports a server unreachable immediately after marking it", () => {
      markUnreachable("http://plex:32400");
      expect(isUnreachable("http://plex:32400")).toBe(true);
    });

    it("returns false for a server that was never marked", () => {
      expect(isUnreachable("http://never:32400")).toBe(false);
    });

    it("stops reporting unreachable once the 45s window expires", () => {
      markUnreachable("http://plex:32400");
      expect(isUnreachable("http://plex:32400")).toBe(true);

      // Just inside the window — still unreachable
      vi.advanceTimersByTime(FAILURE_TTL_MS);
      expect(isUnreachable("http://plex:32400")).toBe(true);

      // One ms past the window — entry expires
      vi.advanceTimersByTime(1);
      expect(isUnreachable("http://plex:32400")).toBe(false);
    });

    it("re-marking refreshes the window", () => {
      markUnreachable("http://plex:32400");
      vi.advanceTimersByTime(40_000);
      markUnreachable("http://plex:32400");
      // 40s after the first mark, but only 0s after the second
      vi.advanceTimersByTime(40_000);
      expect(isUnreachable("http://plex:32400")).toBe(true);
    });
  });

  describe("URL normalization", () => {
    it("treats trailing slashes as the same base URL", () => {
      markUnreachable("http://plex:32400/");
      expect(isUnreachable("http://plex:32400")).toBe(true);
      expect(isUnreachable("http://plex:32400///")).toBe(true);
    });

    it("keeps distinct base URLs independent", () => {
      markUnreachable("http://plex:32400");
      expect(isUnreachable("http://jellyfin:8096")).toBe(false);
    });
  });

  describe("clearUnreachable", () => {
    it("immediately clears a marked server", () => {
      markUnreachable("http://plex:32400");
      clearUnreachable("http://plex:32400");
      expect(isUnreachable("http://plex:32400")).toBe(false);
    });

    it("normalizes trailing slashes when clearing", () => {
      markUnreachable("http://plex:32400/");
      clearUnreachable("http://plex:32400");
      expect(isUnreachable("http://plex:32400/")).toBe(false);
    });

    it("does nothing for an unknown server", () => {
      expect(() => clearUnreachable("http://unknown:1")).not.toThrow();
    });
  });

  describe("getLastFailureMessage", () => {
    it("returns the Error message when marked with an Error", () => {
      markUnreachable("http://plex:32400", new Error("ECONNREFUSED"));
      expect(getLastFailureMessage("http://plex:32400")).toBe("ECONNREFUSED");
    });

    it("stringifies a non-Error value", () => {
      markUnreachable("http://plex:32400", "timed out");
      expect(getLastFailureMessage("http://plex:32400")).toBe("timed out");
    });

    it("stores an empty string when no error is supplied", () => {
      markUnreachable("http://plex:32400");
      expect(getLastFailureMessage("http://plex:32400")).toBe("");
    });

    it("handles a null error as an empty message", () => {
      markUnreachable("http://plex:32400", null);
      expect(getLastFailureMessage("http://plex:32400")).toBe("");
    });

    it("returns undefined for a server that was never marked", () => {
      expect(getLastFailureMessage("http://nope:1")).toBeUndefined();
    });
  });

  describe("_resetForTesting", () => {
    it("clears all tracked failures", () => {
      markUnreachable("http://a:1");
      markUnreachable("http://b:2");
      _resetForTesting();
      expect(isUnreachable("http://a:1")).toBe(false);
      expect(isUnreachable("http://b:2")).toBe(false);
    });
  });

  describe("ServerUnreachableError", () => {
    it("includes the last error message in the message when provided", () => {
      const err = new ServerUnreachableError("http://plex:32400", "ECONNREFUSED");
      expect(err.code).toBe("SERVER_UNREACHABLE");
      expect(err.name).toBe("ServerUnreachableError");
      expect(err.baseURL).toBe("http://plex:32400");
      expect(err.message).toContain("ECONNREFUSED");
      expect(err).toBeInstanceOf(Error);
    });

    it("omits the last-error clause when none is provided", () => {
      const err = new ServerUnreachableError("http://plex:32400");
      expect(err.message).toBe("Server http://plex:32400 is unreachable");
    });
  });
});
