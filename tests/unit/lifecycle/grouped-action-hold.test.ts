import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  appSettings: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import {
  groupScheduledFor,
  heldScheduledFor,
  isGroupSnapshot,
  loadGroupedActionHold,
} from "@/lib/lifecycle/grouped-action-hold";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-27T12:00:00Z");
const hold = new Date(now.getTime() + 7 * DAY);

describe("loadGroupedActionHold", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the hold while it is still ahead", async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue({ groupedActionsHeldUntil: hold });
    expect(await loadGroupedActionHold("u1", now)).toEqual(hold);
    expect(mockPrisma.appSettings.findUnique).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { groupedActionsHeldUntil: true },
    });
  });

  it("returns null once it has passed, on a new install, and without a settings row", async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValueOnce({ groupedActionsHeldUntil: new Date(now.getTime() - 1) });
    expect(await loadGroupedActionHold("u1", now)).toBeNull();
    mockPrisma.appSettings.findUnique.mockResolvedValueOnce({ groupedActionsHeldUntil: null });
    expect(await loadGroupedActionHold("u1", now)).toBeNull();
    mockPrisma.appSettings.findUnique.mockResolvedValueOnce(null);
    expect(await loadGroupedActionHold("u1", now)).toBeNull();
  });
});

describe("isGroupSnapshot", () => {
  it("is a series or music title with no parent title", () => {
    expect(isGroupSnapshot("SERIES", "Breaking Bad", null)).toBe(true);
    expect(isGroupSnapshot("MUSIC", "Radiohead", undefined)).toBe(true);
  });

  it("is not a movie, a two-level snapshot or an untitled one", () => {
    expect(isGroupSnapshot("MOVIE", "Dune", null)).toBe(false);
    expect(isGroupSnapshot("MUSIC", "Creep", "Radiohead")).toBe(false);
    expect(isGroupSnapshot("SERIES", "Pilot", "Breaking Bad")).toBe(false);
    expect(isGroupSnapshot("SERIES", null, null)).toBe(false);
  });
});

describe("groupScheduledFor / heldScheduledFor", () => {
  const due = new Date(now.getTime() + DAY);

  it("moves a group's action to the hold when it would run sooner", () => {
    expect(groupScheduledFor(due, hold, "SERIES")).toEqual(hold);
    expect(heldScheduledFor(due, hold, { type: "MUSIC", title: "Radiohead", parentTitle: null })).toEqual(hold);
  });

  it("keeps a later date, a movie's date, a single item's date and every date without a hold", () => {
    const later = new Date(hold.getTime() + DAY);
    expect(groupScheduledFor(later, hold, "SERIES")).toBe(later);
    expect(groupScheduledFor(due, hold, "MOVIE")).toBe(due);
    expect(heldScheduledFor(due, hold, { type: "SERIES", title: "Pilot", parentTitle: "Breaking Bad" })).toBe(due);
    expect(heldScheduledFor(due, null, { type: "SERIES", title: "Breaking Bad", parentTitle: null })).toBe(due);
  });
});
