import { describe, it, expect, vi } from "vitest";
import { createPreloadedReads } from "@/app/(authenticated)/settings/preloaded-reads";

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("createPreloadedReads", () => {
  it("hands a preloaded answer to the first reader, without asking again", async () => {
    const read = vi.fn(async (path: string) => answer({ path }));
    const reads = createPreloadedReads(read);
    await reads.preload("/api/settings/sso");
    const response = await reads.get("/api/settings/sso");
    expect(await response.json()).toEqual({ path: "/api/settings/sso" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers every later read with a request of its own", async () => {
    const read = vi.fn(async (path: string) => answer({ path }));
    const reads = createPreloadedReads(read);
    await reads.preload("/api/settings/api-keys");
    await reads.get("/api/settings/api-keys");
    // A remount: the preloaded body was read already, so it must not be reused.
    await reads.get("/api/settings/api-keys");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads a path that was never preloaded", async () => {
    const read = vi.fn(async () => answer({}));
    await createPreloadedReads(read).get("/api/settings/sso/me");
    expect(read).toHaveBeenCalledWith("/api/settings/sso/me");
  });

  it("preloads a path once, and settles even when the read fails", async () => {
    const read = vi.fn(async () => {
      throw new Error("offline");
    });
    const reads = createPreloadedReads(read);
    await expect(reads.preload("/api/settings/sso")).resolves.toBeUndefined();
    await reads.preload("/api/settings/sso");
    expect(read).toHaveBeenCalledTimes(1);
    // The reader still sees the failure, as a fetch of its own would show it.
    await expect(reads.get("/api/settings/sso")).rejects.toThrow("offline");
  });
});
