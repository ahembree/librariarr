import { describe, it, expect } from "vitest";
import { compareIds } from "@/lib/conditions/compare-ids";

describe("compareIds", () => {
  it("orders ids lowest first, and equal ids as equal", () => {
    expect(["cb", "ca10", "ca2", "c"].sort(compareIds)).toEqual(["c", "ca10", "ca2", "cb"]);
    expect(compareIds("x", "x")).toBe(0);
  });

  it("agrees with localeCompare on cuids, the ids every row carries", () => {
    // Lowercase base36, as Prisma's cuid() writes them.
    let seed = 11;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const cuid = () =>
      "c" + Array.from({ length: 24 }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(rand() * 36)]).join("");
    const ids = Array.from({ length: 2_000 }, cuid);
    expect([...ids].sort(compareIds)).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});
