import { describe, it, expect } from "vitest";
import { POST_DELETE_INCREMENTAL_LIMIT } from "@/lib/lifecycle/post-delete-resync";
import { MAX_INCREMENTAL_ITEMS } from "@/lib/sync/sync-incremental";

describe("post-delete re-check limit", () => {
  it("matches the incremental sync's own limit", () => {
    // A set the re-check records as small must be one the incremental sync
    // accepts, or every post-delete re-check past the sync's limit falls back.
    expect(POST_DELETE_INCREMENTAL_LIMIT).toBe(MAX_INCREMENTAL_ITEMS);
  });
});
