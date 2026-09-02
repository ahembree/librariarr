import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { expectJson, createTestUser, createTestApiKey } from "../../setup/test-helpers";
import { callV1 } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockEnqueueJob } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));

import { POST } from "@/app/api/v1/lifecycle/run/route";
import {
  MAIN_QUEUE,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
} from "@/lib/jobs/constants";

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
  mockEnqueueJob.mockResolvedValue(true);
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedUser(scope: "READ_ONLY" | "READ_WRITE" = "READ_WRITE") {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id, { scope });
  await getTestPrisma().appSettings.create({ data: { userId: user.id } });
  return { user, raw };
}

function run(key: string, body: unknown) {
  return callV1(POST, { url: "/api/v1/lifecycle/run", method: "POST", key, body });
}

describe("POST /api/v1/lifecycle/run", () => {
  it("enqueues detection on the serial queue and advances its watermark", async () => {
    const { user, raw } = await seedUser();

    const body = await expectJson<{ mode: string; enqueued: boolean }>(
      await run(raw, { mode: "detection" }),
    );
    expect(body).toEqual({ mode: "detection", enqueued: true });

    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_DETECTION,
      { userId: user.id },
      { jobKey: `detection:${user.id}`, queueName: MAIN_QUEUE, maxAttempts: 2 },
    );

    const settings = await getTestPrisma().appSettings.findUnique({
      where: { userId: user.id },
    });
    expect(settings?.lastScheduledLifecycleDetection).not.toBeNull();
    expect(settings?.lastScheduledLifecycleExecution).toBeNull();
  });

  it("enqueues execution with a single attempt and its own watermark", async () => {
    const { user, raw } = await seedUser();

    const body = await expectJson<{ mode: string; enqueued: boolean }>(
      await run(raw, { mode: "execution" }),
    );
    expect(body).toEqual({ mode: "execution", enqueued: true });

    // maxAttempts 1: a half-applied run of destructive Arr actions must not be
    // replayed from the top.
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_EXECUTION,
      { userId: user.id },
      { jobKey: `execution:${user.id}`, queueName: MAIN_QUEUE, maxAttempts: 1 },
    );

    const settings = await getTestPrisma().appSettings.findUnique({
      where: { userId: user.id },
    });
    expect(settings?.lastScheduledLifecycleExecution).not.toBeNull();
    expect(settings?.lastScheduledLifecycleDetection).toBeNull();
  });

  it("500s and leaves the watermark alone when the enqueue fails", async () => {
    const { user, raw } = await seedUser();
    mockEnqueueJob.mockResolvedValue(false);

    const body = await expectJson<{ error: string }>(
      await run(raw, { mode: "detection" }),
      500,
    );
    expect(body.error).toBe("Failed to enqueue lifecycle detection job");

    const settings = await getTestPrisma().appSettings.findUnique({
      where: { userId: user.id },
    });
    expect(settings?.lastScheduledLifecycleDetection).toBeNull();
  });

  it("succeeds when the user has no AppSettings row to stamp", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id, { scope: "READ_WRITE" });

    await expectJson(await run(raw, { mode: "detection" }), 200);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it("400s on an unknown mode", async () => {
    const { raw } = await seedUser();
    const body = await expectJson<{ error: string; details: string[] }>(
      await run(raw, { mode: "everything" }),
      400,
    );
    expect(body.error).toBe("Validation failed");
    expect(body.details.join(" ")).toContain("mode");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("400s when mode is missing", async () => {
    const { raw } = await seedUser();
    await expectJson(await run(raw, {}), 400);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("400s on malformed JSON", async () => {
    const { raw } = await seedUser();
    const request = new NextRequest("http://localhost:3000/api/v1/lifecycle/run", {
      method: "POST",
      headers: { "X-Api-Key": raw, "Content-Type": "application/json" },
      body: "{ not json",
    });
    const body = await expectJson<{ error: string }>(await POST(request), 400);
    expect(body.error).toBe("Invalid JSON in request body");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("403s for a READ_ONLY key and enqueues nothing", async () => {
    const { raw } = await seedUser("READ_ONLY");
    await expectJson(await run(raw, { mode: "detection" }), 403);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });
});
