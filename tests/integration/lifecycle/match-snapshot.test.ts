/**
 * The stored-match readers against the real database: a projected snapshot
 * must read exactly as the whole one does for every key asked for — a key the
 * snapshot lacks stays absent, a JSON null stays null — and a snapshot that is
 * not an object must come back as it is rather than fail the read.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

import { loadStoredMatches, loadStoredMatchMembers } from "@/lib/lifecycle/match-snapshot";

const prisma = getTestPrisma();

describe("match-snapshot", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  async function setup() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const a = await createTestMediaItem(library.id, { type: "SERIES", title: "Pilot", parentTitle: "Lost" });
    const b = await createTestMediaItem(library.id, { type: "SERIES", title: "Tabula Rasa", parentTitle: "Lost" });
    const c = await createTestMediaItem(library.id, { type: "SERIES", title: "Walkabout", parentTitle: "Lost" });
    const ruleSet = await createTestRuleSet(user.id, { type: "SERIES" });
    const other = await createTestRuleSet(user.id, { type: "SERIES", name: "Other" });
    return { a, b, c, ruleSet, other };
  }

  it("takes only the asked-for keys, keeping absent keys absent and nulls null", async () => {
    const { a, b, c, ruleSet, other } = await setup();
    await createTestRuleMatch(ruleSet.id, a.id, {
      id: a.id,
      title: "Lost",
      parentTitle: null,
      memberIds: [a.id, b.id],
      summary: "x".repeat(2000),
      copies: [{ id: "copy", libraryId: "lib2", ratingKey: "rk" }],
    });
    await createTestRuleMatch(ruleSet.id, b.id, {});
    await createTestRuleMatch(other.id, c.id, { id: c.id, title: "Elsewhere" });

    const rows = await loadStoredMatches([ruleSet.id], ["id", "title", "parentTitle", "year", "memberIds", "copies"]);
    const byItem = new Map(rows.map((r) => [r.mediaItemId, r]));

    expect(rows).toHaveLength(2);
    expect(byItem.get(a.id)).toEqual({
      ruleSetId: ruleSet.id,
      mediaItemId: a.id,
      itemData: {
        id: a.id,
        title: "Lost",
        parentTitle: null,
        memberIds: [a.id, b.id],
        copies: [{ id: "copy", libraryId: "lib2", ratingKey: "rk" }],
      },
    });
    expect(byItem.get(b.id)?.itemData).toEqual({});

    const whole = await loadStoredMatches([ruleSet.id, other.id], null);
    expect(whole).toHaveLength(3);
    expect(whole.find((r) => r.mediaItemId === a.id)?.itemData).toMatchObject({ summary: "x".repeat(2000) });
  });

  it("passes a snapshot that is not an object through", async () => {
    const { a, ruleSet } = await setup();
    await prisma.ruleMatch.create({ data: { ruleSetId: ruleSet.id, mediaItemId: a.id, itemData: ["not", "an", "object"] } });

    const rows = await loadStoredMatches([ruleSet.id], ["id"]);
    expect(rows[0].itemData).toEqual(["not", "an", "object"]);

    const members = await loadStoredMatchMembers([ruleSet.id]);
    expect(members).toEqual([{ ruleSetId: ruleSet.id, mediaItemId: a.id, memberIds: null }]);
  });

  it("reads each match's memberIds alone", async () => {
    const { a, b, c, ruleSet } = await setup();
    await createTestRuleMatch(ruleSet.id, a.id, { memberIds: [a.id, c.id], summary: "long" });
    await createTestRuleMatch(ruleSet.id, b.id, { title: "no members" });

    const members = await loadStoredMatchMembers([ruleSet.id]);
    const byItem = new Map(members.map((m) => [m.mediaItemId, m.memberIds]));
    expect(byItem.get(a.id)).toEqual([a.id, c.id]);
    expect(byItem.get(b.id)).toBeNull();
  });
});
