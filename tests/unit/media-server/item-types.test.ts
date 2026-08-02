import { describe, it, expect } from "vitest";
import {
  isMediaItem,
  partitionMediaItems,
  NON_MEDIA_ITEM_TYPES,
} from "@/lib/media-server/item-types";

describe("isMediaItem", () => {
  it.each(["movie", "show", "season", "episode", "artist", "album", "track"])(
    "keeps real media type %s",
    (type) => {
      expect(isMediaItem({ type })).toBe(true);
    }
  );

  it.each([...NON_MEDIA_ITEM_TYPES])("rejects container type %s", (type) => {
    expect(isMediaItem({ type })).toBe(false);
  });

  it("rejects a Plex collection", () => {
    expect(isMediaItem({ type: "collection" })).toBe(false);
  });

  it("rejects a Jellyfin/Emby box set (BoxSet lowercased by mapItemType)", () => {
    expect(isMediaItem({ type: "boxset" })).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isMediaItem({ type: "Collection" })).toBe(false);
    expect(isMediaItem({ type: "BOXSET" })).toBe(false);
  });

  it("keeps an item with no type — the field is optional on some responses", () => {
    // Dropping these would lose real media and hand the sync's stale-item
    // purge a library to wipe.
    expect(isMediaItem({})).toBe(true);
    expect(isMediaItem({ type: undefined })).toBe(true);
    expect(isMediaItem({ type: "" })).toBe(true);
  });

  it("keeps an unknown-but-real type (deny-list, not allow-list)", () => {
    expect(isMediaItem({ type: "musicvideo" })).toBe(true);
    expect(isMediaItem({ type: "some-future-server-type" })).toBe(true);
  });
});

describe("partitionMediaItems", () => {
  it("splits media from containers and reports the skipped count", () => {
    const items = [
      { ratingKey: "1", type: "movie" },
      { ratingKey: "2", type: "collection" },
      { ratingKey: "3", type: "movie" },
      { ratingKey: "4", type: "playlist" },
    ];
    const { media, skipped } = partitionMediaItems(items);
    expect(media.map((m) => m.ratingKey)).toEqual(["1", "3"]);
    // The sync engine adds this to its traversal totals: the server counted
    // the containers in the total it reported, and the stale-item purge only
    // runs when the traversal accounts for every reported item.
    expect(skipped).toBe(2);
  });

  it("reports skipped=0 and the same items when nothing is filtered", () => {
    const items = [{ ratingKey: "1", type: "movie" }];
    const { media, skipped } = partitionMediaItems(items);
    expect(media).toEqual(items);
    expect(skipped).toBe(0);
  });

  it("handles an all-container page", () => {
    const { media, skipped } = partitionMediaItems([
      { type: "collection" },
      { type: "collection" },
    ]);
    expect(media).toEqual([]);
    expect(skipped).toBe(2);
  });

  it("handles an empty page", () => {
    expect(partitionMediaItems([])).toEqual({ media: [], skipped: 0 });
  });
});
