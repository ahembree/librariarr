import { describe, it, expect, beforeEach } from "vitest";
import {
  stampFirstSeen,
  pruneFirstSeen,
  rememberSession,
  getRememberedSession,
  _resetFirstSeen,
} from "@/lib/media-server/session-first-seen";
import type { MediaSession } from "@/lib/media-server/types";

function session(sessionId: string, username = "alice"): MediaSession {
  return {
    sessionId,
    userId: "u1",
    username,
    userThumb: "",
    title: "Arrival",
    type: "movie",
    player: { product: "Plex Web", platform: "Chrome", state: "playing", address: "10.0.0.1", local: true },
  } as MediaSession;
}

describe("session first-seen tracking", () => {
  beforeEach(() => _resetFirstSeen());

  it("records the first timestamp and keeps it stable across calls", () => {
    expect(stampFirstSeen("s1", "sess1", 1000)).toBe(1000);
    // A later call (e.g. the list route after the SSE route) must NOT reset it.
    expect(stampFirstSeen("s1", "sess1", 5000)).toBe(1000);
  });

  it("prunes ended sessions but preserves those on an unreachable server", () => {
    stampFirstSeen("s1", "a", 1000);
    stampFirstSeen("s2", "b", 1000);

    // s1 polled and still has "a"; s2 was NOT polled this cycle (unreachable).
    pruneFirstSeen(new Set(["s1:a"]), new Set(["s1", "s2"]), new Set(["s1"]));

    expect(stampFirstSeen("s1", "a", 9000)).toBe(1000); // kept (still active)
    expect(stampFirstSeen("s2", "b", 9000)).toBe(1000); // kept (server unreachable)
  });

  it("drops an active session that ended on a polled server", () => {
    stampFirstSeen("s1", "a", 1000);
    pruneFirstSeen(new Set(), new Set(["s1"]), new Set(["s1"]));
    // "a" no longer active on polled s1 → dropped → new stamp.
    expect(stampFirstSeen("s1", "a", 9000)).toBe(9000);
  });

  it("drops entries for a removed/disabled server outright", () => {
    stampFirstSeen("gone", "a", 1000);
    pruneFirstSeen(new Set(), new Set(["s1"]), new Set(["s1"]));
    expect(stampFirstSeen("gone", "a", 9000)).toBe(9000);
  });

  it("remembers the last detail seen for a session, per server", () => {
    rememberSession("s1", session("a", "alice"));
    rememberSession("s2", session("a", "bob"));

    expect(getRememberedSession("s1", "a")?.username).toBe("alice");
    expect(getRememberedSession("s2", "a")?.username).toBe("bob");
    expect(getRememberedSession("s1", "missing")).toBeUndefined();
  });

  it("overwrites the detail as a session changes", () => {
    rememberSession("s1", session("a", "alice"));
    rememberSession("s1", { ...session("a", "alice"), title: "Dune" });
    expect(getRememberedSession("s1", "a")?.title).toBe("Dune");
  });

  it("prunes remembered detail in lockstep with first-seen", () => {
    rememberSession("s1", session("a"));
    rememberSession("s2", session("b"));
    rememberSession("gone", session("c"));

    // s1 polled and "a" still active; s2 not polled; "gone" no longer a server.
    pruneFirstSeen(new Set(["s1:a"]), new Set(["s1", "s2"]), new Set(["s1"]));

    expect(getRememberedSession("s1", "a")).toBeDefined();
    expect(getRememberedSession("s2", "b")).toBeDefined(); // server unreachable, kept
    expect(getRememberedSession("gone", "c")).toBeUndefined();

    // Now "a" ends on a polled server.
    pruneFirstSeen(new Set(), new Set(["s1", "s2"]), new Set(["s1"]));
    expect(getRememberedSession("s1", "a")).toBeUndefined();
  });

  it("prunes a remembered session that was never stamped", () => {
    rememberSession("s1", session("a"));
    pruneFirstSeen(new Set(), new Set(["s1"]), new Set(["s1"]));
    expect(getRememberedSession("s1", "a")).toBeUndefined();
  });

  it("bounds the remembered detail, evicting least-recently-seen first", () => {
    for (let i = 0; i < 520; i++) rememberSession("s1", session(`sess${i}`));
    // The 20 oldest were evicted; the newest 500 survive.
    expect(getRememberedSession("s1", "sess0")).toBeUndefined();
    expect(getRememberedSession("s1", "sess19")).toBeUndefined();
    expect(getRememberedSession("s1", "sess20")).toBeDefined();
    expect(getRememberedSession("s1", "sess519")).toBeDefined();
  });

  it("keeps a re-seen session alive under pressure", () => {
    rememberSession("s1", session("keeper"));
    for (let i = 0; i < 499; i++) rememberSession("s1", session(`sess${i}`));
    // Re-seeing "keeper" makes it the newest entry, so the next 499 inserts
    // evict the others rather than it.
    rememberSession("s1", session("keeper"));
    for (let i = 500; i < 999; i++) rememberSession("s1", session(`sess${i}`));
    expect(getRememberedSession("s1", "keeper")).toBeDefined();
  });
});
