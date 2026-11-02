import { describe, it, expect, vi } from "vitest";
import { withSharedSession, sharedSessionRead } from "@/lib/auth/shared-session";

describe("withSharedSession", () => {
  it("reads once for everything inside one run", async () => {
    const read = vi.fn(async () => ({ userId: "u" }));
    const [a, b] = await withSharedSession(() =>
      Promise.all([sharedSessionRead(read), Promise.resolve().then(() => sharedSessionRead(read))]),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it("reads afresh in each run and outside one", async () => {
    const read = vi.fn(async () => ({}));
    await withSharedSession(() => sharedSessionRead(read));
    await withSharedSession(() => sharedSessionRead(read));
    await sharedSessionRead(read);
    await sharedSessionRead(read);
    expect(read).toHaveBeenCalledTimes(4);
  });
});
