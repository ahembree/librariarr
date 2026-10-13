import { describe, it, expect, vi } from "vitest";
import { createModuleLoader } from "@/lib/module-loader";

describe("createModuleLoader", () => {
  it("does not load until asked", () => {
    const load = vi.fn(async () => "mod");
    const loader = createModuleLoader(load);
    expect(load).not.toHaveBeenCalled();
    expect(loader.get()).toBeNull();
  });

  it("loads once, shares the load between concurrent callers, then answers from memory", async () => {
    const load = vi.fn(async () => "mod");
    const loader = createModuleLoader(load);

    const [a, b] = await Promise.all([loader.load(), loader.load()]);
    expect(a).toBe("mod");
    expect(b).toBe("mod");
    expect(loader.get()).toBe("mod");
    await loader.load();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed load so the next request tries again", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValueOnce("mod");
    const loader = createModuleLoader(load);

    await expect(loader.load()).rejects.toThrow("chunk failed");
    expect(loader.get()).toBeNull();
    await expect(loader.load()).resolves.toBe("mod");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
