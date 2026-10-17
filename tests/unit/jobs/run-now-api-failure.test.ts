/** An API-queued execution whose enqueue fails reports it and leaves the schedule alone. */
import { describe, it, expect, vi } from "vitest";

const m = vi.hoisted(() => ({ enqueueJob: vi.fn().mockResolvedValue(false), update: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { appSettings: { update: m.update } } }));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: m.enqueueJob }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runJobNow } from "@/lib/jobs/run-now";

describe("runJobNow execution via an API key", () => {
  it("returns an error when the job could not be queued", async () => {
    await expect(
      runJobNow("u1", "execution", "via API key", { viaApiKey: "Script" }),
    ).resolves.toEqual({ ok: false, error: "Failed to enqueue execution job" });
    expect(m.enqueueJob.mock.calls[0][2]).toEqual({
      jobKey: "execution-api:u1",
      queueName: "librariarr:main",
      maxAttempts: 1,
    });
    expect(m.update).not.toHaveBeenCalled();
  });
});
