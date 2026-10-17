import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import {
  createTestUser,
  createTestRadarrInstance,
  createTestSonarrInstance,
  createTestLidarrInstance,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

import { validateActionConfig } from "@/lib/lifecycle/action-config";

describe("validateActionConfig", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it.each([
    ["MOVIE", "DELETE_RADARR"],
    ["SERIES", "UNMONITOR_SONARR"],
    ["MUSIC", "DELETE_LIDARR"],
    ["MOVIE", "DO_NOTHING"],
    ["SERIES", null],
    ["MUSIC", undefined],
  ] as const)("accepts %s with %s and no instance", async (libraryType, actionType) => {
    const user = await createTestUser();
    expect(
      await validateActionConfig({ userId: user.id, libraryType, actionType, arrInstanceId: null }),
    ).toBeNull();
  });

  it.each([
    ["MOVIE", "DELETE_SONARR", "sonarr"],
    ["MOVIE", "DELETE_LIDARR", "lidarr"],
    ["SERIES", "DELETE_RADARR", "radarr"],
    ["MUSIC", "UNMONITOR_SONARR", "sonarr"],
  ] as const)("rejects %s with %s", async (libraryType, actionType, family) => {
    const user = await createTestUser();
    const err = await validateActionConfig({ userId: user.id, libraryType, actionType, arrInstanceId: null });
    expect(err).toContain(`targets ${family}`);
    expect(err).toContain(libraryType.toLowerCase());
  });

  it("ignores an action type with an unknown suffix", async () => {
    const user = await createTestUser();
    expect(
      await validateActionConfig({ userId: user.id, libraryType: "MOVIE", actionType: "SOMETHING", arrInstanceId: null }),
    ).toBeNull();
  });

  it("accepts an instance of the library's family owned by the user", async () => {
    const user = await createTestUser();
    const radarr = await createTestRadarrInstance(user.id);
    const sonarr = await createTestSonarrInstance(user.id);
    const lidarr = await createTestLidarrInstance(user.id);
    expect(await validateActionConfig({ userId: user.id, libraryType: "MOVIE", actionType: "DELETE_RADARR", arrInstanceId: radarr.id })).toBeNull();
    expect(await validateActionConfig({ userId: user.id, libraryType: "SERIES", actionType: "DELETE_SONARR", arrInstanceId: sonarr.id })).toBeNull();
    expect(await validateActionConfig({ userId: user.id, libraryType: "MUSIC", actionType: "DELETE_LIDARR", arrInstanceId: lidarr.id })).toBeNull();
  });

  it("checks a tags-only configuration against the library's family", async () => {
    const user = await createTestUser();
    const sonarr = await createTestSonarrInstance(user.id);
    const err = await validateActionConfig({
      userId: user.id, libraryType: "MOVIE", actionType: "DO_NOTHING", arrInstanceId: sonarr.id,
    });
    expect(err).toMatch(/require a radarr instance/);
  });

  it("rejects an instance of another family", async () => {
    const user = await createTestUser();
    const radarr = await createTestRadarrInstance(user.id);
    const err = await validateActionConfig({
      userId: user.id, libraryType: "SERIES", actionType: "DELETE_SONARR", arrInstanceId: radarr.id,
    });
    expect(err).toMatch(/Arr instance not found.*sonarr/);
  });

  it("rejects a non-existent instance even when one of the family exists", async () => {
    const user = await createTestUser();
    await createTestLidarrInstance(user.id);
    expect(
      await validateActionConfig({ userId: user.id, libraryType: "MUSIC", actionType: "DELETE_LIDARR", arrInstanceId: "nope" }),
    ).toMatch(/not found/);
  });

  it("reports the family mismatch before looking up the instance", async () => {
    const user = await createTestUser();
    const err = await validateActionConfig({
      userId: user.id, libraryType: "MOVIE", actionType: "DELETE_SONARR", arrInstanceId: "nope",
    });
    expect(err).toMatch(/targets sonarr/);
  });
});
