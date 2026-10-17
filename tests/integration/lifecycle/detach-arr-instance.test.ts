import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestRuleSet } from "../../setup/test-helpers";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { detachDeletedArrInstance } from "@/lib/arr/detach-instance";

const INSTANCE = "radarr-1";

async function action(userId: string, status: "PENDING" | "COMPLETED" | "FAILED", arrInstanceId: string | null) {
  return getTestPrisma().lifecycleAction.create({
    data: { userId, actionType: "DELETE_RADARR", status, scheduledFor: new Date(), arrInstanceId },
  });
}

describe("detachDeletedArrInstance", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("cancels only PENDING actions bound to the instance", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const pending = await action(user.id, "PENDING", INSTANCE);
    const completed = await action(user.id, "COMPLETED", INSTANCE);
    const failed = await action(user.id, "FAILED", INSTANCE);
    const otherInstance = await action(user.id, "PENDING", "radarr-2");

    await prisma.$transaction((tx) => detachDeletedArrInstance(tx, user.id, INSTANCE, "Radarr"));

    const remaining = await prisma.lifecycleAction.findMany({ select: { id: true, status: true } });
    expect(remaining.map((a) => a.id)).not.toContain(pending.id);
    expect(remaining).toHaveLength(3);
    expect(remaining).toEqual(expect.arrayContaining([
      { id: completed.id, status: "COMPLETED" },
      { id: failed.id, status: "FAILED" },
      { id: otherInstance.id, status: "PENDING" },
    ]));
  });

  it("turns off and detaches rule sets whose action uses the instance", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const del = await createTestRuleSet(user.id, {
      actionEnabled: true, actionType: "DELETE_RADARR", arrInstanceId: INSTANCE,
    });
    const nullType = await createTestRuleSet(user.id, { actionEnabled: true, arrInstanceId: INSTANCE });
    const tagsOnly = await createTestRuleSet(user.id, {
      actionEnabled: true, actionType: "DO_NOTHING", arrInstanceId: INSTANCE, addArrTags: ["keep"],
    });
    const removeTags = await createTestRuleSet(user.id, {
      actionEnabled: true, actionType: "DO_NOTHING", arrInstanceId: INSTANCE, removeArrTags: ["x"],
    });

    await prisma.$transaction((tx) => detachDeletedArrInstance(tx, user.id, INSTANCE, "Radarr"));

    for (const rs of [del, nullType, tagsOnly, removeTags]) {
      const row = await prisma.ruleSet.findUniqueOrThrow({ where: { id: rs.id } });
      expect(row.arrInstanceId, rs.id).toBeNull();
      expect(row.actionEnabled, rs.id).toBe(false);
    }
    expect(warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("turned off the action of 4 rule set(s)"));
  });

  it("detaches but keeps enabled a Do Nothing rule set with no tags", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const rs = await createTestRuleSet(user.id, {
      actionEnabled: true, actionType: "DO_NOTHING", arrInstanceId: INSTANCE,
    });

    await prisma.$transaction((tx) => detachDeletedArrInstance(tx, user.id, INSTANCE, "Radarr"));

    const row = await prisma.ruleSet.findUniqueOrThrow({ where: { id: rs.id } });
    expect(row.arrInstanceId).toBeNull();
    expect(row.actionEnabled).toBe(true);
    expect(warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("detached 1 rule set"));
  });

  it("leaves rule sets on other instances alone", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const otherInstance = await createTestRuleSet(user.id, {
      actionEnabled: true, actionType: "DELETE_RADARR", arrInstanceId: "radarr-2",
    });

    await prisma.$transaction((tx) => detachDeletedArrInstance(tx, user.id, INSTANCE, "Radarr"));

    const row = await prisma.ruleSet.findUniqueOrThrow({ where: { id: otherInstance.id } });
    expect(row.arrInstanceId).toBe("radarr-2");
    expect(row.actionEnabled).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs nothing when nothing referenced the instance", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    await prisma.$transaction((tx) => detachDeletedArrInstance(tx, user.id, INSTANCE, "Radarr"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("rolls back with the deleting transaction", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const rs = await createTestRuleSet(user.id, {
      actionEnabled: true, actionType: "DELETE_RADARR", arrInstanceId: INSTANCE,
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await detachDeletedArrInstance(tx, user.id, INSTANCE, "Radarr");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const row = await prisma.ruleSet.findUniqueOrThrow({ where: { id: rs.id } });
    expect(row.arrInstanceId).toBe(INSTANCE);
    expect(row.actionEnabled).toBe(true);
  });
});
