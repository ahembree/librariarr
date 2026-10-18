import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The blast-radius ceiling.
 *
 * Unlimited by DEFAULT on purpose — Librariarr exists to delete media without
 * supervision, and a user whose rules legitimately select thousands of items
 * should not be second-guessed. What the ceiling defends against is not a rule
 * being wrong but something UPSTREAM of it being wrong: every vacuous-match
 * guard refuses a hazard someone already found, and this bounds the ones nobody
 * has.
 */
const m = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { appSettings: { findFirst: m.findFirst } } }));

import { checkDeleteCeiling, checkDeleteCeilingForRun, getDeleteCeiling } from "@/lib/lifecycle/delete-ceiling";

const DESTRUCTIVE = "DELETE_RADARR";
const HARMLESS = "UNMONITOR_SONARR";

function limit(value: number | null) {
  m.findFirst.mockResolvedValue({ maxAutoDeleteItems: value });
}

describe("checkDeleteCeiling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows anything when no ceiling is configured", async () => {
    limit(null);
    const verdict = await checkDeleteCeiling("u1", Array(50_000).fill(DESTRUCTIVE), "scheduled");
    expect(verdict).toEqual({ allowed: true, count: 50_000, limit: null });
    expect(m.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { maxAutoDeleteItems: true },
    });
  });

  it("allows a run exactly at the ceiling", async () => {
    // "Safe to delete X" means X is safe, not X-1.
    limit(10);
    await expect(
      checkDeleteCeiling("u1", Array(10).fill(DESTRUCTIVE), "scheduled"),
    ).resolves.toMatchObject({ allowed: true, count: 10 });
  });

  it("blocks one item over, and says how many and against what", async () => {
    limit(10);
    const verdict = await checkDeleteCeiling("u1", Array(11).fill(DESTRUCTIVE), "scheduled");
    expect(verdict.allowed).toBe(false);
    expect(verdict.count).toBe(11);
    expect(verdict.limit).toBe(10);
    expect(verdict.reason).toContain("would delete 11 item(s)");
    expect(verdict.reason).toContain("configured limit of 10.");
  });

  it("counts only destructive actions", async () => {
    // Unmonitor, tag and search runs are reversible and must not be held; a
    // ceiling that counted them would fire on routine housekeeping.
    limit(5);
    await expect(
      checkDeleteCeiling("u1", [...Array(100).fill(HARMLESS), ...Array(5).fill(DESTRUCTIVE)], "scheduled"),
    ).resolves.toMatchObject({ allowed: true, count: 5 });
  });

  it("treats a non-positive stored value as no ceiling, not as block-everything", async () => {
    // A 0 almost certainly means "off". Reading it as a literal ceiling would
    // silently disable lifecycle deletion entirely.
    for (const stored of [0, -1]) {
      limit(stored);
      await expect(getDeleteCeiling("u1")).resolves.toBeNull();
      await expect(
        checkDeleteCeiling("u1", Array(1_000).fill(DESTRUCTIVE), "scheduled"),
      ).resolves.toMatchObject({ allowed: true });
    }
  });

  it("treats a missing settings row as no ceiling", async () => {
    m.findFirst.mockResolvedValue(null);
    await expect(
      checkDeleteCeiling("u1", Array(1_000).fill(DESTRUCTIVE), "scheduled"),
    ).resolves.toMatchObject({ allowed: true, limit: null });
  });

  it("holds the whole batch rather than trimming it to the limit", async () => {
    // Acting on an arbitrary subset of a match set you already distrust is not
    // safer, just quieter — so the verdict is all-or-nothing, and nothing in it
    // suggests a partial run.
    limit(2);
    const verdict = await checkDeleteCeiling("u1", Array(9).fill(DESTRUCTIVE), "scheduled");
    expect(verdict.allowed).toBe(false);
    expect(verdict).not.toHaveProperty("allowedCount");
    expect(verdict.reason).toMatch(/Nothing was deleted/i);
  });
});

describe("checkDeleteCeilingForRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts a destructive run by its size", async () => {
    m.findFirst.mockResolvedValue({ maxAutoDeleteItems: 1000 });
    const verdict = await checkDeleteCeilingForRun("u1", "DELETE_RADARR", 10_000);
    expect(verdict).toMatchObject({ allowed: false, count: 10_000, limit: 1000 });
  });

  it("never counts a non-destructive run", async () => {
    m.findFirst.mockResolvedValue({ maxAutoDeleteItems: 1 });
    expect(await checkDeleteCeilingForRun("u1", "UNMONITOR_RADARR", 50)).toEqual({ allowed: true, count: 0, limit: 1 });
  });

  it("tells a hand-started run to select less, not to run it manually", async () => {
    // A query action is already manual — "run it manually" offered nothing.
    m.findFirst.mockResolvedValue({ maxAutoDeleteItems: 25 });
    const verdict = await checkDeleteCeilingForRun("u1", "DELETE_RADARR", 30);
    expect(verdict.reason).toContain("Select at most 25 item(s)");
    expect(verdict.reason).not.toMatch(/manually|Pending page/);
  });
});

describe("checkDeleteCeiling refusal wording", () => {
  it("points a scheduled run at the Pending page and a manual one at the selection", async () => {
    m.findFirst.mockResolvedValue({ maxAutoDeleteItems: 2 });
    const scheduled = await checkDeleteCeiling("u1", Array(3).fill(DESTRUCTIVE), "scheduled");
    expect(scheduled.reason).toContain("Pending page");
    const manual = await checkDeleteCeiling("u1", Array(3).fill(DESTRUCTIVE), "manual");
    expect(manual.reason).toContain("Select at most 2 item(s)");
    expect(manual.reason).not.toContain("Pending page");
  });
});
