import { describe, it, expect } from "vitest";
import {
  normalizeJellyfinMessage,
  jellyfinSessionsSignature,
} from "@/lib/media-server/realtime/normalize-jellyfin";

const ctx = { serverId: "s2", serverType: "JELLYFIN" as const };

describe("normalizeJellyfinMessage", () => {
  it("maps Sessions to session-changed", () => {
    const events = normalizeJellyfinMessage({ MessageType: "Sessions", Data: [] }, ctx);
    expect(events).toEqual([
      expect.objectContaining({ kind: "session-changed", serverId: "s2", serverType: "JELLYFIN" }),
    ]);
  });

  it("maps PlaybackStart / PlaybackProgress to session-changed", () => {
    expect(normalizeJellyfinMessage({ MessageType: "PlaybackStart" }, ctx)[0].kind).toBe("session-changed");
    expect(normalizeJellyfinMessage({ MessageType: "PlaybackProgress" }, ctx)[0].kind).toBe("session-changed");
  });

  it("maps PlaybackStopped to session-changed + watch-changed", () => {
    expect(normalizeJellyfinMessage({ MessageType: "PlaybackStopped" }, ctx).map((e) => e.kind)).toEqual([
      "session-changed",
      "watch-changed",
    ]);
  });

  it("maps LibraryChanged to library-changed with counts", () => {
    const events = normalizeJellyfinMessage(
      { MessageType: "LibraryChanged", Data: { ItemsAdded: ["a", "b"], ItemsRemoved: [], ItemsUpdated: ["c"] } },
      ctx,
    );
    expect(events[0]).toMatchObject({ kind: "library-changed", detail: { added: 2, removed: 0, updated: 1 } });
  });

  it("maps UserDataChanged to watch-changed", () => {
    expect(normalizeJellyfinMessage({ MessageType: "UserDataChanged" }, ctx)[0].kind).toBe("watch-changed");
  });

  it("ignores keepalive, control, and unrelated message types", () => {
    expect(normalizeJellyfinMessage({ MessageType: "ForceKeepAlive", Data: 60 }, ctx)).toEqual([]);
    expect(normalizeJellyfinMessage({ MessageType: "KeepAlive" }, ctx)).toEqual([]);
    expect(normalizeJellyfinMessage({ MessageType: "GeneralCommand" }, ctx)).toEqual([]);
    expect(normalizeJellyfinMessage({ MessageType: "ScheduledTasksInfo" }, ctx)).toEqual([]);
    expect(normalizeJellyfinMessage({ MessageType: "RestartRequired" }, ctx)).toEqual([]);
  });

  it("ignores malformed input", () => {
    expect(normalizeJellyfinMessage(null, ctx)).toEqual([]);
    expect(normalizeJellyfinMessage("nope", ctx)).toEqual([]);
    expect(normalizeJellyfinMessage({}, ctx)).toEqual([]);
    expect(normalizeJellyfinMessage({ MessageType: 42 }, ctx)).toEqual([]);
  });

  it("carries the EMBY server type through", () => {
    const events = normalizeJellyfinMessage({ MessageType: "Sessions" }, { serverId: "e1", serverType: "EMBY" });
    expect(events[0].serverType).toBe("EMBY");
  });
});

describe("jellyfinSessionsSignature", () => {
  const playing = (over: Record<string, unknown> = {}) => ({
    Id: "sess1",
    NowPlayingItem: { Id: "item1" },
    PlayState: { IsPaused: false, PositionTicks: 1000 },
    ...over,
  });

  it("is empty when nothing is playing", () => {
    expect(jellyfinSessionsSignature([])).toBe("");
    expect(jellyfinSessionsSignature([{ Id: "x" }])).toBe(""); // no NowPlayingItem
    expect(jellyfinSessionsSignature("nope")).toBe("");
  });

  it("ignores playback position (periodic frames collapse to one signature)", () => {
    const a = jellyfinSessionsSignature([playing({ PlayState: { IsPaused: false, PositionTicks: 1000 } })]);
    const b = jellyfinSessionsSignature([playing({ PlayState: { IsPaused: false, PositionTicks: 9_999_999 } })]);
    expect(a).toBe(b);
  });

  it("changes when pause state, item, or transcoding changes", () => {
    const base = jellyfinSessionsSignature([playing()]);
    expect(jellyfinSessionsSignature([playing({ PlayState: { IsPaused: true } })])).not.toBe(base);
    expect(jellyfinSessionsSignature([playing({ NowPlayingItem: { Id: "item2" } })])).not.toBe(base);
    expect(jellyfinSessionsSignature([playing({ TranscodingInfo: {} })])).not.toBe(base);
  });

  it("distinguishes transcode kind (video vs audio vs both)", () => {
    const videoOnly = jellyfinSessionsSignature([playing({ TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: true } })]);
    const audioOnly = jellyfinSessionsSignature([playing({ TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: false } })]);
    const both = jellyfinSessionsSignature([playing({ TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: false } })]);
    const direct = jellyfinSessionsSignature([playing()]);
    // All four playback modes produce distinct signatures.
    expect(new Set([videoOnly, audioOnly, both, direct]).size).toBe(4);
  });

  it("is order-independent across sessions", () => {
    const s1 = playing({ Id: "a", NowPlayingItem: { Id: "i1" } });
    const s2 = playing({ Id: "b", NowPlayingItem: { Id: "i2" } });
    expect(jellyfinSessionsSignature([s1, s2])).toBe(jellyfinSessionsSignature([s2, s1]));
  });
});
