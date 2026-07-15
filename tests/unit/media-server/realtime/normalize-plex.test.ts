import { describe, it, expect } from "vitest";
import { normalizePlexMessage } from "@/lib/media-server/realtime/normalize-plex";

const ctx = { serverId: "s1" };

describe("normalizePlexMessage", () => {
  it("maps a playing notification to session-changed", () => {
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "playing",
          PlaySessionStateNotification: [{ sessionKey: "1", state: "playing", viewOffset: 1000 }],
        },
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "session-changed", serverId: "s1", serverType: "PLEX" });
  });

  it("adds watch-changed when a play stops", () => {
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "playing",
          PlaySessionStateNotification: [{ sessionKey: "1", state: "stopped" }],
        },
      },
      ctx,
    );
    expect(events.map((e) => e.kind)).toEqual(["session-changed", "watch-changed"]);
  });

  it("emits session-changed for a bare playing container", () => {
    const events = normalizePlexMessage({ NotificationContainer: { type: "playing" } }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("session-changed");
  });

  it("maps timeline entries to library-changed", () => {
    const events = normalizePlexMessage(
      { NotificationContainer: { type: "timeline", TimelineEntry: [{ itemID: "5", state: 5 }] } },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("library-changed");
  });

  it("maps an ended library.* activity to library-changed", () => {
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "activity",
          ActivityNotification: [{ event: "ended", Activity: { type: "library.update.section" } }],
        },
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("library-changed");
  });

  it("ignores in-progress / non-library activities", () => {
    expect(
      normalizePlexMessage(
        {
          NotificationContainer: {
            type: "activity",
            ActivityNotification: [{ event: "started", Activity: { type: "library.update.section" } }],
          },
        },
        ctx,
      ),
    ).toEqual([]);
    expect(
      normalizePlexMessage(
        {
          NotificationContainer: {
            type: "activity",
            ActivityNotification: [{ event: "ended", Activity: { type: "provider.subscriptions.process" } }],
          },
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it("accepts a top-level container without the NotificationContainer wrapper", () => {
    const events = normalizePlexMessage(
      { type: "playing", PlaySessionStateNotification: [{ state: "playing" }] },
      ctx,
    );
    expect(events[0].kind).toBe("session-changed");
  });

  it("ignores unrelated types and malformed input", () => {
    expect(normalizePlexMessage({ NotificationContainer: { type: "status" } }, ctx)).toEqual([]);
    expect(normalizePlexMessage({ NotificationContainer: { type: "transcodeSession.update" } }, ctx)).toEqual([]);
    expect(normalizePlexMessage(null, ctx)).toEqual([]);
    expect(normalizePlexMessage("nope", ctx)).toEqual([]);
    expect(normalizePlexMessage({}, ctx)).toEqual([]);
  });
});
