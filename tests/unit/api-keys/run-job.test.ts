import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ runJobNow: vi.fn() }));

vi.mock("@/lib/jobs/run-now", () => ({ runJobNow: m.runJobNow }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runJobForApiKey } from "@/lib/api-keys/run-job";
import { runAsApiKey } from "@/lib/api-keys/principal";

const PRINCIPAL = {
  keyId: "key-1",
  userId: "user-1",
  name: "n8n",
  prefix: "lbr_abcdef",
  scopes: ["sync:write" as const],
};

describe("runJobForApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to run outside an authenticated API key request", async () => {
    const res = await runJobForApiKey("sync");
    expect(res.status).toBe(401);
    expect(m.runJobNow).not.toHaveBeenCalled();
  });

  it("queues the job for the key's owner, attributed to the key, and answers 202", async () => {
    m.runJobNow.mockResolvedValue({ ok: true });
    const res = await runAsApiKey(PRINCIPAL, () => runJobForApiKey("detection"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect(m.runJobNow).toHaveBeenCalledWith("user-1", "detection", 'via API key "n8n"');
  });

  it("passes a failed enqueue through as 500", async () => {
    m.runJobNow.mockResolvedValue({ ok: false, error: "Failed to enqueue execution job" });
    const res = await runAsApiKey(PRINCIPAL, () => runJobForApiKey("execution"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to enqueue execution job" });
  });

  it("answers 500 with internal paths scrubbed when the run throws", async () => {
    m.runJobNow.mockRejectedValue(new Error("boom at /app/src/lib/jobs/run-now.ts:12"));
    const res = await runAsApiKey(PRINCIPAL, () => runJobForApiKey("sync"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^Job failed:/);
    expect(body.error).not.toContain("/app/src");
  });
});
