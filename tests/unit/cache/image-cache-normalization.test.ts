import { describe, it, expect } from "vitest";
import { normalizeCacheUrl } from "@/lib/image-cache/image-cache";

describe("normalizeCacheUrl", () => {
  describe("Plex thumb URLs", () => {
    it("strips timestamp from thumb URLs", () => {
      expect(normalizeCacheUrl("/library/metadata/12345/thumb/1706000000"))
        .toBe("/library/metadata/12345/thumb");
    });

    it("strips timestamp from art URLs", () => {
      expect(normalizeCacheUrl("/library/metadata/12345/art/1706000000"))
        .toBe("/library/metadata/12345/art");
    });

    it("handles single-digit metadata IDs", () => {
      expect(normalizeCacheUrl("/library/metadata/1/thumb/9999999999"))
        .toBe("/library/metadata/1/thumb");
    });

    it("handles large metadata IDs", () => {
      expect(normalizeCacheUrl("/library/metadata/999999/thumb/1"))
        .toBe("/library/metadata/999999/thumb");
    });

    it("produces same result for different timestamps on same item", () => {
      const a = normalizeCacheUrl("/library/metadata/42/thumb/1000000000");
      const b = normalizeCacheUrl("/library/metadata/42/thumb/2000000000");
      expect(a).toBe(b);
      expect(a).toBe("/library/metadata/42/thumb");
    });

    it("produces different results for different metadata IDs", () => {
      const a = normalizeCacheUrl("/library/metadata/100/thumb/1706000000");
      const b = normalizeCacheUrl("/library/metadata/200/thumb/1706000000");
      expect(a).not.toBe(b);
    });
  });

  describe("Jellyfin/Emby URLs", () => {
    it("passes through Jellyfin primary image URLs unchanged", () => {
      expect(normalizeCacheUrl("/Items/abc123/Images/Primary"))
        .toBe("/Items/abc123/Images/Primary");
    });

    it("passes through Jellyfin backdrop URLs unchanged", () => {
      expect(normalizeCacheUrl("/Items/abc123/Images/Backdrop"))
        .toBe("/Items/abc123/Images/Backdrop");
    });

    it("passes through Jellyfin series image URLs unchanged", () => {
      expect(normalizeCacheUrl("/Items/series-id/Images/Primary"))
        .toBe("/Items/series-id/Images/Primary");
    });
  });

  describe("edge cases", () => {
    it("passes through empty string", () => {
      expect(normalizeCacheUrl("")).toBe("");
    });

    it("passes through non-Plex relative paths", () => {
      expect(normalizeCacheUrl("/some/other/path")).toBe("/some/other/path");
    });

    it("does not strip non-numeric trailing segments", () => {
      expect(normalizeCacheUrl("/library/metadata/12345/thumb/abc"))
        .toBe("/library/metadata/12345/thumb/abc");
    });

    it("does not modify URLs with extra path segments after timestamp", () => {
      expect(normalizeCacheUrl("/library/metadata/12345/thumb/1706000000/extra"))
        .toBe("/library/metadata/12345/thumb/1706000000/extra");
    });
  });
});
