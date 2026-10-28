import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ensureAppSettingsRow } from "@/lib/settings/app-settings-row";

const prisma = getTestPrisma();

describe("ensureAppSettingsRow", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("makes one row however many run at once", async () => {
    // An upsert with an empty update is a read then a create in Prisma, so
    // side by side the second create failed on the unique userId.
    for (let i = 0; i < 5; i++) {
      await cleanDatabase();
      const user = await createTestUser();
      await Promise.all(Array.from({ length: 6 }, () => ensureAppSettingsRow(user.id)));
      expect(await prisma.appSettings.count({ where: { userId: user.id } })).toBe(1);
    }
  });

  it("leaves an existing row as it is", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({ data: { userId: user.id, accentColor: "violet" } });
    await ensureAppSettingsRow(user.id);
    const row = await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.accentColor).toBe("violet");
  });

  it("works inside a transaction", async () => {
    const user = await createTestUser();
    await prisma.$transaction((tx) => ensureAppSettingsRow(user.id, tx));
    expect(await prisma.appSettings.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe("getPlexClientId", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.resetModules();
  });

  it("agrees on one client id when first asked from several places at once", async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.systemConfig.deleteMany();
      vi.resetModules();
      const { getPlexClientId } = await import("@/lib/plex/auth");
      const ids = await Promise.all(Array.from({ length: 6 }, () => getPlexClientId()));
      expect(new Set(ids).size).toBe(1);
      const row = await prisma.systemConfig.findUniqueOrThrow({ where: { id: "singleton" } });
      expect(row.plexClientId).toBe(ids[0]);
    }
  });
});
