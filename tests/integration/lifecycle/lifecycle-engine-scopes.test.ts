/**
 * Lifecycle engine scope paths not reached elsewhere: the series and artist
 * aggregate engines with stream / watch-history / Arr / Seerr data, their
 * "no active rules" guards, the flat engine's empty-WHERE safety net, and
 * groupSeriesResults' representative choice.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import type { ArrMetadata, SeerrMetadata } from "@/lib/rules/lifecycle-engine";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  evaluateSeriesScope,
  evaluateMusicScope,
  evaluateLifecycleRules,
  groupSeriesResults,
} from "@/lib/rules/lifecycle-engine";

function rule(field: string, operator: string, value: string | number = "", extra: Partial<LifecycleRule> = {}): LifecycleRule {
  return { id: `${field}-${operator}`, field, operator, value, condition: "AND", ...extra };
}

function group(rules: LifecycleRule[], extra: Partial<LifecycleRuleGroup> = {}): LifecycleRuleGroup {
  return { id: "g", condition: "AND", rules, groups: [], ...extra };
}

const arrMeta = (o: Partial<ArrMetadata> = {}) => ({ arrId: 1, tags: [], monitored: true, ...o }) as unknown as ArrMetadata;
const seerrMeta = (o: Partial<SeerrMetadata> = {}): SeerrMetadata => ({
  requested: true, requestCount: 1, requestDate: null, requestedBy: ["alice"], approvalDate: null, declineDate: null, ...o,
});

describe("lifecycle engine scopes", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seedSeries() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    const mk = async (show: string, s: number, e: number, extra: Record<string, unknown> = {}) => {
      const ep = await createTestMediaItem(lib.id, {
        type: "SERIES", title: `${show} ${s}x${e}`, parentTitle: show, seasonNumber: s, episodeNumber: e, ...extra,
      });
      return ep;
    };
    const a1 = await mk("Alpha", 1, 1, { playCount: 2, lastPlayedAt: new Date("2024-03-01T00:00:00Z"), addedAt: new Date("2023-01-01T00:00:00Z") });
    const a2 = await mk("Alpha", 1, 2, { addedAt: new Date("2023-06-01T00:00:00Z") });
    const a3 = await mk("Alpha", 2, 1, { addedAt: new Date("2023-03-01T00:00:00Z") });
    await prisma.mediaItem.update({ where: { id: a1.id }, data: { originallyAvailableAt: new Date("2022-01-01T00:00:00Z") } });
    await prisma.mediaItem.update({ where: { id: a3.id }, data: { originallyAvailableAt: new Date("2022-09-01T00:00:00Z"), lastPlayedAt: new Date("2024-02-01T00:00:00Z") } });
    await prisma.mediaItem.update({ where: { id: a2.id }, data: { originallyAvailableAt: new Date("2022-05-01T00:00:00Z") } });
    const b1 = await mk("Beta", 1, 1);
    for (const ep of [a1, a2, a3]) {
      await prisma.mediaItemExternalId.create({ data: { mediaItemId: ep.id, source: "TVDB", externalId: "100" } });
    }
    await prisma.mediaItemExternalId.create({ data: { mediaItemId: b1.id, source: "TVDB", externalId: "200" } });
    await prisma.mediaStream.create({ data: { mediaItemId: a1.id, streamType: 2, language: "English", codec: "aac" } });
    await prisma.mediaStream.create({ data: { mediaItemId: b1.id, streamType: 2, language: "German", codec: "aac" } });
    await prisma.watchHistory.create({ data: { mediaItemId: a2.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date() } });
    await prisma.watchHistory.create({ data: { mediaItemId: a3.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date() } });
    return { user, server, lib, a1, a2, a3, b1 };
  }

  describe("evaluateSeriesScope", () => {
    it("refuses to evaluate with no active rules", async () => {
      const { server } = await seedSeries();
      expect(await evaluateSeriesScope([], [server.id])).toEqual([]);
      expect(await evaluateSeriesScope([group([rule("title", "equals", "Alpha", { enabled: false })])], [server.id])).toEqual([]);
    });

    it("aggregates streams, watch history and episode dates per show", async () => {
      const { server, a1, a2, a3 } = await seedSeries();
      const rules = [group([
        rule("audioLanguage", "equals", "English"),
        rule("watchedByUser", "equals", "alice"),
        rule("lastEpisodeAiredAt", "equals", "2022-09-01"),
        rule("lastEpisodeAddedAt", "equals", "2023-06-01"),
        rule("latestEpisodeViewDate", "equals", "2024-02-01"),
        rule("seriesLastPlayedAt", "equals", "2024-03-01"),
        rule("watchedEpisodeCount", "equals", "1"),
      ])];
      const res = await evaluateSeriesScope(rules, [server.id]);
      expect(res).toHaveLength(1);
      expect(res[0].title).toBe("Alpha");
      expect([...res[0].memberIds].sort()).toEqual([a1.id, a2.id, a3.id].sort());
      expect(res[0]).toMatchObject({ matchedEpisodes: 3, availableEpisodeCount: 3, playCount: 2 });
      expect(res[0].watchedEpisodePercentage).toBeCloseTo(100 / 3);
      expect((res[0].streams as unknown[]).length).toBe(1);
    });

    it("evaluates Arr and Seerr criteria against the series' TVDB id", async () => {
      const { server } = await seedSeries();
      const rules = [group([rule("arrTag", "contains", "keep"), rule("seerrRequestedBy", "contains", "alice")])];
      const res = await evaluateSeriesScope(rules, [server.id], { "100": arrMeta({ tags: ["keep"] }) }, { "TVDB:100": seerrMeta() });
      expect(res.map((r) => r.title)).toEqual(["Alpha"]);
    });

    it("restricts members to matching episodes when asked", async () => {
      const { server, a2, a3 } = await seedSeries();
      const rules = [group([rule("watchedEpisodeCount", "greaterThanOrEqual", "1"), rule("watchedByUser", "equals", "alice"), rule("serverCount", "equals", "1")])];
      const res = await evaluateSeriesScope(rules, [server.id], { "100": arrMeta() }, undefined, true);
      expect(res).toHaveLength(1);
      expect([...res[0].memberIds].sort()).toEqual([a2.id, a3.id].sort());
    });
  });

  describe("evaluateMusicScope", () => {
    async function seedMusic() {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });
      const prisma = getTestPrisma();
      const t1 = await createTestMediaItem(lib.id, { type: "MUSIC", title: "Song 1", parentTitle: "Band", playCount: 1, lastPlayedAt: new Date("2024-01-01T00:00:00Z") });
      const t2 = await createTestMediaItem(lib.id, { type: "MUSIC", title: "Song 2", parentTitle: "Band", lastPlayedAt: new Date("2024-05-01T00:00:00Z") });
      const t3 = await createTestMediaItem(lib.id, { type: "MUSIC", title: "Other", parentTitle: "Solo" });
      await prisma.mediaItemExternalId.create({ data: { mediaItemId: t1.id, source: "MUSICBRAINZ", externalId: "mb-band" } });
      await prisma.mediaStream.create({ data: { mediaItemId: t2.id, streamType: 2, codec: "flac", language: "English" } });
      await prisma.watchHistory.create({ data: { mediaItemId: t2.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: new Date() } });
      return { server, t1, t2, t3 };
    }

    it("refuses to evaluate with no active rules", async () => {
      const { server } = await seedMusic();
      expect(await evaluateMusicScope([], [server.id])).toEqual([]);
      expect(await evaluateMusicScope([group([rule("title", "equals", "x", { enabled: false })])], [server.id])).toEqual([]);
    });

    it("aggregates streams, plays and watch history per artist and evaluates Arr data", async () => {
      const { server, t1, t2 } = await seedMusic();
      const rules = [group([
        rule("streamAudioCodec", "equals", "flac"),
        rule("watchedByUser", "equals", "bob"),
        rule("arrMonitored", "equals", "true"),
        rule("lastPlayedAt", "equals", "2024-05-01"),
      ])];
      const res = await evaluateMusicScope(rules, [server.id], { "mb-band": arrMeta() });
      expect(res).toHaveLength(1);
      expect([...(res[0].memberIds as string[])].sort()).toEqual([t1.id, t2.id].sort());
      expect(await evaluateMusicScope(rules, [server.id])).toEqual([]);
    });
  });

  describe("evaluateLifecycleRules", () => {
    it("an Arr-only rule set with no Arr data never sweeps the library", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "M" });
      expect(await evaluateLifecycleRules([group([rule("arrTag", "contains", "x", { negate: true })])], "MOVIE", [server.id])).toEqual([]);
    });

    it("music items resolve Arr metadata by MusicBrainz id", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });
      const t = await createTestMediaItem(lib.id, { type: "MUSIC", title: "Song", parentTitle: "Band" });
      await createTestMediaItem(lib.id, { type: "MUSIC", title: "Song B", parentTitle: "Band B" });
      await getTestPrisma().mediaItemExternalId.create({ data: { mediaItemId: t.id, source: "MUSICBRAINZ", externalId: "mb1" } });
      const res = await evaluateLifecycleRules([group([rule("arrTag", "contains", "keep")])], "MUSIC", [server.id], { mb1: arrMeta({ tags: ["keep"] }) });
      expect(res.map((r) => r.id)).toEqual([t.id]);
    });
  });
});

describe("groupSeriesResults", () => {
  it("groups per library and series key, keeping the lowest id as representative", () => {
    const base = { parentTitle: "Show", seriesKey: "tvdb:1", libraryId: "L1", seasonNumber: 1, episodeNumber: 1 };
    const rows = [
      { ...base, id: "c", title: "Ep C", playCount: 1, fileSize: "100", lastPlayedAt: "2024-01-01T00:00:00Z" },
      { ...base, id: "a", title: "Ep A", playCount: 2, fileSize: null, lastPlayedAt: new Date("2024-03-01T00:00:00Z") },
      { ...base, id: "b", title: "Ep B", playCount: 0, fileSize: "50", lastPlayedAt: null },
      { ...base, id: "z", title: "Other lib", libraryId: "L2", playCount: 0, fileSize: null },
    ];
    const res = groupSeriesResults(rows);
    expect(res).toHaveLength(2);
    const main = res.find((r) => r.libraryId === "L1")!;
    expect(main).toMatchObject({
      id: "a", title: "Show", parentTitle: null, seasonNumber: null, episodeNumber: null,
      playCount: 3, fileSize: "150", lastPlayedAt: "2024-03-01T00:00:00.000Z", matchedEpisodes: 3,
    });
    expect(main.memberIds).toEqual(["c", "a", "b"]);
    const other = res.find((r) => r.libraryId === "L2")!;
    expect(other).toMatchObject({ fileSize: null, lastPlayedAt: null, matchedEpisodes: 1 });
  });
});
