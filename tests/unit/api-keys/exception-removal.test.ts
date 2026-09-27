import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { lifecycleException: { count: m.count } } }));

import { reserveExceptionRemoval } from "@/lib/api-keys/exception-removal";
import { runAsApiKey } from "@/lib/api-keys/principal";
import { reserveApiDestructive, resetApiDestructiveBudget } from "@/lib/api-keys/destructive-budget";

const PRINCIPAL = { keyId: "k1", userId: "user-1", name: "n8n", prefix: "lbr_abcdef", scopes: ["lifecycle:execute" as const] };

describe("reserveExceptionRemoval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetApiDestructiveBudget();
  });

  it("fails closed outside an API key request", async () => {
    const res = await reserveExceptionRemoval(["e1"]);
    expect(res?.status).toBe(401);
    expect(m.count).not.toHaveBeenCalled();
  });

  it("charges only the exceptions that exist and belong to the key's owner", async () => {
    m.count.mockResolvedValue(2);
    expect(await runAsApiKey(PRINCIPAL, () => reserveExceptionRemoval(["e1", "e2", "missing"]))).toBeNull();
    expect(m.count).toHaveBeenCalledWith({ where: { id: { in: ["e1", "e2", "missing"] }, userId: "user-1" } });
    expect(reserveApiDestructive(0)).toEqual({ ok: true, remaining: 98 });
  });

  it("answers 429 with Retry-After once the hour's budget is spent, charging nothing", async () => {
    for (let i = 0; i < 4; i++) reserveApiDestructive(25);
    m.count.mockResolvedValue(1);
    const res = await runAsApiKey(PRINCIPAL, () => reserveExceptionRemoval(["e1"]));
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).not.toBeNull();
    expect(reserveApiDestructive(0)).toEqual({ ok: true, remaining: 0 });
  });

  it("lets a removal that matches nothing through without a charge", async () => {
    for (let i = 0; i < 4; i++) reserveApiDestructive(25);
    m.count.mockResolvedValue(0);
    expect(await runAsApiKey(PRINCIPAL, () => reserveExceptionRemoval(["missing"]))).toBeNull();
  });
});
