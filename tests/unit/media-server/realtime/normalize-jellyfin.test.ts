import { describe, it, expect } from "vitest";
import {
  normalizeJellyfinMessage,
  jellyfinSessionsSignature,
} from "@/lib/media-server/realtime/normalize-jellyfin";

const ctx = { serverId: "s2", serverType: "JELLYFIN" as const };
// PlaybackStart/PlaybackProgress/PlaybackStopped are Emby's frames — Jellyfin's
// SessionMessageType has none of them and reports playback through Sessions
// and UserDataChanged — so they are driven with an Emby context.
const embyCtx = { serverId: "e1", serverType: "EMBY" as const };

describe("normalizeJellyfinMessage", () => {
  it("maps Sessions to session-changed", () => {
    const events = normalizeJellyfinMessage({ MessageType: "Sessions", Data: [] }, ctx);
    expect(events).toEqual([
      expect.objectContaining({ kind: "session-changed", serverId: "s2", serverType: "JELLYFIN" }),
    ]);
  });

  it("maps PlaybackStart / PlaybackProgress to session-changed", () => {
    expect(normalizeJellyfinMessage({ MessageType: "PlaybackStart" }, embyCtx).map((e) => e.kind)).toEqual([
      "session-changed",
    ]);
    expect(normalizeJellyfinMessage({ MessageType: "PlaybackProgress" }, embyCtx).map((e) => e.kind)).toEqual([
      "session-changed",
    ]);
  });

  it("maps PlaybackStopped to session-changed + watch-changed", () => {
    expect(normalizeJellyfinMessage({ MessageType: "PlaybackStopped" }, embyCtx).map((e) => e.kind)).toEqual([
      "session-changed",
      "watch-changed",
    ]);
  });

  it("maps LibraryChanged to library-changed with counts and item ids", () => {
    // The full LibraryUpdateInfo shape; item ids are dashless GUIDs.
    const events = normalizeJellyfinMessage(
      {
        MessageType: "LibraryChanged",
        MessageId: "6f1c0a3e-2b4d-4c55-9e1a-0d3b7f2a9c11",
        Data: {
          FoldersAddedTo: ["f137a2dd21bbc1b99aa5c0f6bf02a805"],
          FoldersRemovedFrom: [],
          ItemsAdded: ["2c1f4d0e9a8b4c3d8e7f6a5b4c3d2e1f", "3d2e1f0a9b8c4d3e8f7a6b5c4d3e2f1a"],
          ItemsRemoved: ["9a8b7c6d5e4f40312a1b0c9d8e7f6a5b"],
          ItemsUpdated: ["4e3f2a1b0c9d4e8f9a7b6c5d4e3f2a1b"],
          CollectionFolders: ["f137a2dd21bbc1b99aa5c0f6bf02a805"],
          IsEmpty: false,
        },
      },
      ctx,
    );
    expect(events).toEqual([
      {
        kind: "library-changed",
        serverId: "s2",
        serverType: "JELLYFIN",
        at: expect.any(Number),
        detail: {
          added: 2,
          removed: 1,
          updated: 1,
          changedIds: [
            "2c1f4d0e9a8b4c3d8e7f6a5b4c3d2e1f",
            "3d2e1f0a9b8c4d3e8f7a6b5c4d3e2f1a",
            "4e3f2a1b0c9d4e8f9a7b6c5d4e3f2a1b",
          ],
          removedIds: ["9a8b7c6d5e4f40312a1b0c9d8e7f6a5b"],
        },
      },
    ]);
  });

  it("reads a LibraryChanged frame with no Data as no change", () => {
    expect(normalizeJellyfinMessage({ MessageType: "LibraryChanged", Data: null }, ctx)).toEqual([
      expect.objectContaining({ kind: "library-changed", detail: { changedIds: [], removedIds: [] } }),
    ]);
  });

  it("maps UserDataChanged to watch-changed", () => {
    expect(normalizeJellyfinMessage({ MessageType: "UserDataChanged" }, ctx).map((e) => e.kind)).toEqual([
      "watch-changed",
    ]);
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
    const events = normalizeJellyfinMessage({ MessageType: "Sessions", Data: [] }, embyCtx);
    expect(events).toEqual([expect.objectContaining({ serverId: "e1", serverType: "EMBY" })]);
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
