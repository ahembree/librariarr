/**
 * Regression tests for defects found by an adversarial review of the v1
 * surface. Each case here failed against the code as originally written, so
 * they pin the fix rather than restate behaviour already covered elsewhere.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  expectJson,
} from "../../setup/test-helpers";
import { callV1 } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Not silenced with the usual no-op mock: these tests assert that a flood of
// rejected requests does NOT keep writing rows, so the logger must reach the
// real LogEntry table for the count to mean anything.
vi.mock("@/lib/logger", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  const write = async (level: string, category: string, source: string, message: string) => {
    await getTestPrisma()
      .logEntry.create({
        data: {
          level: level as "INFO" | "WARN" | "ERROR",
          category: category as "API" | "BACKEND" | "DB",
          source,
          message,
        },
      })
      .catch(() => {});
  };
  const make = (category: string) => ({
    debug: vi.fn(),
    info: vi.fn((s: string, m: string) => write("INFO", category, s, m)),
    warn: vi.fn((s: string, m: string) => write("WARN", category, s, m)),
    error: vi.fn((s: string, m: string) => write("ERROR", category, s, m)),
  });
  return { logger: make("BACKEND"), apiLogger: make("API"), dbLogger: make("DB") };
});

vi.mock("@/lib/jobs/client", () => ({ enqueueJob: vi.fn(async () => true) }));

import { GET as GET_ME } from "@/app/api/v1/me/route";
import { GET as GET_ITEM } from "@/app/api/v1/library/items/[id]/route";
import { GET as GET_SERIES } from "@/app/api/v1/library/series/route";
import { GET as GET_SYNC_STATUS } from "@/app/api/v1/sync/status/route";
import { POST as POST_SYNC } from "@/app/api/v1/sync/route";
import { DELETE as DELETE_EXCEPTION } from "@/app/api/v1/lifecycle/exceptions/[id]/route";
import { apiKeyFailureLimiter, apiKeyRateLimiter } from "@/lib/rate-limit/rate-limiter";
import { appCache } from "@/lib/cache/memory-cache";
import { resetApiKeyTouchState } from "@/lib/auth/api-key";

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  appCache.clear();
  resetApiKeyTouchState();
  // The limiters are process-wide singletons; a neighbouring test's traffic
  // would otherwise decide this one's verdict.
  (apiKeyFailureLimiter as any).store.clear();
  (apiKeyRateLimiter as any).store.clear();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seed() {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id, { scope: "READ_WRITE" });
  const server = await createTestServer(user.id, { name: "Main" });
  const library = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
  return { user, raw, server, library };
}

describe("v1 hardening — unauthenticated flood", () => {
  it("stops writing a log row for every rejected request once the failure budget is spent", async () => {
    const prisma = getTestPrisma();

    // Well past the 20-per-window failure budget.
    for (let i = 0; i < 60; i++) {
      await callV1(GET_ME, { url: "/api/v1/me", key: `lbr_bogus-${i}` });
    }

    const logged = await prisma.logEntry.count({ where: { source: "api-v1" } });
    // Bounded by the limiter, not by the number of requests sent. Without the
    // cap this was 60 — one durable row per anonymous request, which is a
    // database an unauthenticated caller can grow at will.
    expect(logged).toBeLessThanOrEqual(20);
    expect(logged).toBeGreaterThan(0);
  });

  it("answers 429 rather than 401 once an IP has burned its failure budget", async () => {
    for (let i = 0; i < 20; i++) {
      await callV1(GET_ME, { url: "/api/v1/me", key: "lbr_bogus" });
    }
    const res = await callV1(GET_ME, { url: "/api/v1/me", key: "lbr_bogus" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("never spends a valid key's request from the failure budget", async () => {
    const { raw } = await seed();
    // Comfortably more than the failure budget; all authenticate, so none of
    // them may count against it.
    for (let i = 0; i < 30; i++) {
      const res = await callV1(GET_ME, { url: "/api/v1/me", key: raw });
      expect(res.status).toBe(200);
    }
    expect(apiKeyFailureLimiter.peek("api-key-fail:unknown").limited).toBe(false);
  });

  it("keeps serving a valid key while another client floods from the same address", async () => {
    const { raw } = await seed();

    // Every test request carries the same (absent) client IP, which is also the
    // real-world shape when TRUST_PROXY_HEADERS=false puts every caller in one
    // bucket, or when an integration shares a NAT with whoever is guessing.
    for (let i = 0; i < 60; i++) {
      await callV1(GET_ME, { url: "/api/v1/me", key: `lbr_bogus-${i}` });
    }

    // The flood must not become a denial of service against the integration
    // that actually holds a key: a gate placed ahead of authentication would
    // answer 429 here, which is the whole reason the budget only counts
    // requests that have already failed to authenticate.
    const res = await callV1(GET_ME, { url: "/api/v1/me", key: raw });
    expect(res.status).toBe(200);
  });
});

describe("v1 hardening — data exposure", () => {
  it("does not return the media server's on-disk file path with an item", async () => {
    const { raw, library } = await seed();
    const item = await createTestMediaItem(library.id, {
      title: "Blade Runner",
      type: "MOVIE",
      filePath: "/mnt/user/media/movies/Blade Runner (1982)/Blade.Runner.1982.mkv",
    } as any);

    const res = await callV1(GET_ITEM, {
      url: `/api/v1/library/items/${item.id}`,
      key: raw,
      params: { id: item.id },
    });
    const body = await expectJson<any>(res);

    expect(body.item.id).toBe(item.id);
    expect(body.item).not.toHaveProperty("filePath");
    expect(JSON.stringify(body)).not.toContain("/mnt/user/media");
  });

  it("scrubs internal addresses out of a reported sync error", async () => {
    const { raw, server } = await seed();
    const prisma = getTestPrisma();
    await prisma.syncJob.create({
      data: {
        mediaServerId: server.id,
        status: "FAILED",
        startedAt: new Date(),
        completedAt: new Date(),
        error: "connect ECONNREFUSED 192.168.1.50:32400 while reading /config/cache/images",
      },
    });

    const body = await expectJson<any>(
      await callV1(GET_SYNC_STATUS, { url: "/api/v1/sync/status", key: raw }),
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain("192.168.1.50");
    // The caller still learns that it failed, just not the network topology.
    expect(text).toContain("ECONNREFUSED");
  });
});

describe("v1 hardening — request handling", () => {
  it("treats a POST /api/v1/sync with no body at all as 'sync everything'", async () => {
    const { raw } = await seed();

    // `curl -X POST` sends no body; rejecting it would fail the most obvious
    // way to call an endpoint whose every field is optional.
    const request = new Request("http://localhost:3000/api/v1/sync", {
      method: "POST",
      headers: { "X-Api-Key": raw },
    });
    const res = await POST_SYNC(request as any);
    expect(res.status).toBe(200);

    // And an explicit empty object still works.
    const res2 = await callV1(POST_SYNC, {
      url: "/api/v1/sync",
      method: "POST",
      body: {},
      key: raw,
    });
    expect(res2.status).toBe(200);
  });

  it("still rejects a body that is present but malformed", async () => {
    const { raw } = await seed();
    const request = new Request("http://localhost:3000/api/v1/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": raw },
      body: "{not json",
    });
    const res = await POST_SYNC(request as any);
    const body = await expectJson<any>(res, 400);
    expect(body.error).toBe("Invalid JSON in request body");
  });

  it("does not delete every exception when the id segment is missing", async () => {
    const { user, raw, library } = await seed();
    const prisma = getTestPrisma();
    const a = await createTestMediaItem(library.id, { title: "Keep A", type: "MOVIE" });
    const b = await createTestMediaItem(library.id, { title: "Keep B", type: "MOVIE" });
    await prisma.lifecycleException.createMany({
      data: [
        { userId: user.id, mediaItemId: a.id },
        { userId: user.id, mediaItemId: b.id },
      ],
    });

    // No params at all — Prisma drops an `undefined` filter rather than
    // matching nothing, so an unguarded deleteMany would wipe both rows.
    const res = await callV1(DELETE_EXCEPTION, {
      url: "/api/v1/lifecycle/exceptions/",
      method: "DELETE",
      key: raw,
    });
    expect(res.status).toBe(404);
    expect(await prisma.lifecycleException.count()).toBe(2);
  });
});

describe("v1 hardening — stable paging", () => {
  it("pages the grouped series list without repeating or dropping a show", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id, { name: "Main" });
    const library = await createTestLibrary(server.id, { title: "TV", type: "SERIES" });

    // Titles that collate equal under localeCompare but are distinct shows, so
    // the sort has a tie block straddling the page boundary.
    const shows = ["Show A", "show-a", "Show B", "show b!", "Show C", "show,c"];
    for (const [i, show] of shows.entries()) {
      await createTestMediaItem(library.id, {
        title: `${show} E1`,
        type: "SERIES",
        parentTitle: show,
        seasonNumber: 1,
        episodeNumber: i + 1,
      });
    }

    const seen: string[] = [];
    for (let page = 1; page <= 6; page++) {
      const body = await expectJson<any>(
        await callV1(GET_SERIES, {
          url: "/api/v1/library/series",
          key: raw,
          searchParams: { limit: "1", page: String(page) },
        }),
      );
      seen.push(...body.items.map((i: any) => i.title));
    }

    // Every distinct show exactly once across the pages — no duplicate, none
    // skipped, regardless of how the tied titles collate.
    expect(seen).toHaveLength(new Set(seen).size);
    expect(new Set(seen).size).toBe(shows.length);
  });
});

describe("v1 hardening — a read-only key does not get free 403s", () => {
  it("counts a rejected write against the key's own budget", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id, { scope: "READ_ONLY" });

    // 120 requests/minute is the per-key budget. Every one of these is a 403,
    // and each 403 also costs a log write — so if the scope check short-circuited
    // ahead of the limiter, a read-only key would have an unlimited free channel.
    let forbidden = 0;
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      const res = await callV1(POST_SYNC, {
        url: "/api/v1/sync",
        method: "POST",
        body: {},
        key: raw,
      });
      if (res.status === 403) forbidden++;
      if (res.status === 429) limited++;
    }

    expect(forbidden).toBe(120);
    expect(limited).toBe(10);
  });
});
