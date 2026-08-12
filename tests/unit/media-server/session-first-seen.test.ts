import { describe, it, expect, beforeEach } from "vitest";
import {
  stampFirstSeen,
  pruneFirstSeen,
  _resetFirstSeen,
} from "@/lib/media-server/session-first-seen";

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
});
