/**
 * E2E regression: a `watchedByUser` value is compared LITERALLY, and Phase 1
 * agrees with Phase 2 about what that means.
 *
 * Prisma compiles `{ equals, mode: "insensitive" }` to Postgres `ILIKE $1`
 * (verified against the generated SQL), so `_` and `%` inside the value are
 * pattern metacharacters. Phase 2 (`matchNameListField`) compares with
 * `list.includes(value)` and treats them as ordinary characters. Un-escaped,
 * the SAME rule therefore selected a different set depending on whether
 * something unrelated beside it — an Arr/Seerr field, a genre rule, a
 * resolution rule — forced in-memory re-evaluation. On a DELETE rule set that
 * is a different set of files.
 *
 * `_` is not exotic in a username (`alice_smith`, `media_user`, `plex_admin`),
 * and `%` is the fail-open: `ILIKE '%'` matches every play there is.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { evaluateLifecycleRules } = await import("@/lib/rules/lifecycle-engine");
const { matchNameListField } = await import("@/lib/conditions/name-list-eval");

let serverId: string;

/** username → the movie title only that user watched. */
const WATCHERS: Record<string, string> = {
  // The rule's target. The underscore is the metacharacter.
  alice_smith: "Alice Movie",
  // Differs from `alice_smith` at exactly the underscore, so `ILIKE
  // 'alice_smith'` matches it and a literal comparison does not.
  aliceXsmith: "Decoy Movie",
};

beforeAll(async () => {
  await cleanDatabase();
  const prisma = getTestPrisma();

  const user = await prisma.user.create({
    data: { username: "test-watched-by-user-escaping", passwordHash: "x" },
  });
  const server = await prisma.mediaServer.create({
    data: {
      userId: user.id,
      name: "Test",
      type: "PLEX",
      url: "http://test:32400",
      accessToken: "x",
      machineId: "watched-by-user-escaping",
    },
  });
  serverId = server.id;

  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });

  for (const [username, title] of Object.entries(WATCHERS)) {
    const item = await prisma.mediaItem.create({
      data: { libraryId: library.id, ratingKey: `rk-${username}`, title, type: "MOVIE" },
    });
    await prisma.watchHistory.create({
      data: { mediaItemId: item.id, mediaServerId: server.id, serverUsername: username },
    });
  }

  await prisma.mediaItem.create({
    data: { libraryId: library.id, ratingKey: "rk-none", title: "Never Watched", type: "MOVIE" },
  });
});

afterAll(async () => {
  await disconnectTestDb();
});

function group(operator: string, value: string): LifecycleRuleGroup[] {
  return [{
    id: "g", condition: "AND",
    rules: [{ id: "r", field: "watchedByUser", operator, value, condition: "AND" }],
    groups: [],
  }];
}

/** Phase 1 — the Prisma WHERE the engine builds. */
async function phase1(operator: string, value: string): Promise<string[]> {
  const items = await evaluateLifecycleRules(group(operator, value), "MOVIE", [serverId]);
  return items.map((i) => i.title).sort();
}

/**
 * Phase 2 — the shared in-memory evaluator, over the same data. Titles are
 * derived from the fixture rather than the DB so this half is independent of
 * the query under test.
 */
function phase2(operator: string, value: string): string[] {
  return Object.entries(WATCHERS)
    .filter(([username]) => matchNameListField([username], operator, value) === true)
    .map(([, title]) => title)
    .sort();
}

describe("watchedByUser compares literally in both phases", () => {
  it("does not let `_` in a username act as a single-character wildcard", async () => {
    expect(await phase1("equals", "alice_smith")).toEqual(["Alice Movie"]);
    expect(phase2("equals", "alice_smith")).toEqual(["Alice Movie"]);
  });

  it("does not let `%` match every play (the fail-open)", async () => {
    // `ILIKE '%'` is satisfied by every row, so an un-escaped `%` turned
    // "watched by %" into "watched by anyone" — and `notEquals "%"` into
    // "never watched by anyone", which on a DELETE rule set is the library.
    expect(await phase1("equals", "%")).toEqual([]);
    expect(phase2("equals", "%")).toEqual([]);
  });

  it("agrees between the phases for the negative form too", async () => {
    // Phase 1 `notEquals` compiles to `watchHistory: { none: … }`, so a pattern
    // that over-matches there under-matches the rule — the opposite direction
    // from `equals`, and just as wrong.
    const p1 = await phase1("notEquals", "alice_smith");
    expect(p1).toContain("Decoy Movie");
    expect(p1).toContain("Never Watched");
    expect(p1).not.toContain("Alice Movie");
  });

  it("still matches an ordinary username", async () => {
    // The escaping must not break the overwhelmingly common case.
    expect(await phase1("equals", "aliceXsmith")).toEqual(["Decoy Movie"]);
  });

  it("is case-insensitive, as both phases document", async () => {
    expect(await phase1("equals", "ALICE_SMITH")).toEqual(["Alice Movie"]);
    expect(phase2("equals", "ALICE_SMITH")).toEqual(["Alice Movie"]);
  });
});
