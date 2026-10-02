import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { Prisma } from "@/generated/prisma/client";
import { BACKUP_EXCLUDED_TABLES, BACKUP_TABLE_ORDER } from "@/lib/backup/backup-service";

/**
 * Restore begins with `TRUNCATE "User" CASCADE`, so a model that is neither
 * backed up nor deliberately excluded is destroyed by every restore and never
 * refilled — silently. `Collection` and `TrashManagedResource` were lost that
 * way (and, because rule sets reference collections, a backup holding any
 * collection-assigned rule set failed to restore at all). This pins the list
 * to Prisma's own model enum so a new model has to be placed on purpose.
 */
const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

describe("backup table coverage", () => {
  it("backs up every model except the deliberate exclusions", () => {
    const models = Object.values(Prisma.ModelName).map(delegateName).sort();
    const covered = [...BACKUP_TABLE_ORDER, ...BACKUP_EXCLUDED_TABLES].sort();
    expect(covered).toEqual(models);
  });

  it("lists no table twice and never both backs up and excludes one", () => {
    expect(new Set(BACKUP_TABLE_ORDER).size).toBe(BACKUP_TABLE_ORDER.length);
    for (const excluded of BACKUP_EXCLUDED_TABLES) {
      expect(BACKUP_TABLE_ORDER as readonly string[]).not.toContain(excluded);
    }
  });

  it("restores a table only after the tables it references", () => {
    const at = (t: (typeof BACKUP_TABLE_ORDER)[number]) => BACKUP_TABLE_ORDER.indexOf(t);
    expect(at("collection")).toBeLessThan(at("ruleSet"));
    expect(at("sonarrInstance")).toBeLessThan(at("trashManagedResource"));
    expect(at("radarrInstance")).toBeLessThan(at("trashManagedResource"));
    expect(at("user")).toBeLessThan(at("collection"));
  });
});
