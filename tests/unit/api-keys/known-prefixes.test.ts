import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { apiKey: { findMany } } }));

import { invalidateKnownApiKeyPrefixes, knownApiKeyPrefixes } from "@/lib/api-keys/known-prefixes";

beforeEach(() => {
  findMany.mockReset();
  invalidateKnownApiKeyPrefixes();
});

describe("knownApiKeyPrefixes", () => {
  it("is the set of issued prefixes, read once and then answered from the cache", async () => {
    findMany.mockResolvedValue([{ prefix: "lbr_aaaaaa" }, { prefix: "lbr_bbbbbb" }]);

    const first = await knownApiKeyPrefixes();
    const second = await knownApiKeyPrefixes();

    expect([...first].sort()).toEqual(["lbr_aaaaaa", "lbr_bbbbbb"]);
    expect(second.has("lbr_aaaaaa")).toBe(true);
    expect(second.has("lbr_zzzzzz")).toBe(false);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ select: { prefix: true } });
  });

  it("is read again after a key is created or deleted", async () => {
    findMany.mockResolvedValue([{ prefix: "lbr_aaaaaa" }]);
    await knownApiKeyPrefixes();

    invalidateKnownApiKeyPrefixes();
    findMany.mockResolvedValue([{ prefix: "lbr_aaaaaa" }, { prefix: "lbr_cccccc" }]);

    expect((await knownApiKeyPrefixes()).has("lbr_cccccc")).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read", async () => {
    findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(knownApiKeyPrefixes()).rejects.toThrow("db down");
    findMany.mockResolvedValue([{ prefix: "lbr_aaaaaa" }]);
    expect((await knownApiKeyPrefixes()).size).toBe(1);
  });

  it("shares one read between concurrent callers", async () => {
    findMany.mockResolvedValue([{ prefix: "lbr_aaaaaa" }]);
    await Promise.all([knownApiKeyPrefixes(), knownApiKeyPrefixes(), knownApiKeyPrefixes()]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
