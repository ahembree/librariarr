import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { lifecycleException: { count: m.count } } }));

import { removeExceptionsCharged } from "@/lib/api-keys/exception-removal";
import { runAsApiKey } from "@/lib/api-keys/principal";
import { reserveApiDestructive, resetApiDestructiveBudget } from "@/lib/api-keys/destructive-budget";

const PRINCIPAL = { keyId: "k1", userId: "user-1", name: "n8n", prefix: "lbr_abcdef", scopes: ["lifecycle:execute" as const] };

/** A remover that answers like the app's bulk DELETE, having removed `deleted`. */
function remover(deleted: number, status = 200) {
  return vi.fn(async () => Response.json(status === 200 ? { deleted } : { error: "Not found" }, { status }));
}
const deletedOf = async (res: Response) => ((await res.json()) as { deleted: number }).deleted;

describe("removeExceptionsCharged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetApiDestructiveBudget();
  });

  it("fails closed outside an API key request", async () => {
    const remove = remover(1);
    const res = await removeExceptionsCharged(["e1"], remove, deletedOf);
    expect(res.status).toBe(401);
    expect(m.count).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("charges only the exceptions that exist and belong to the key's owner", async () => {
    m.count.mockResolvedValue(2);
    const res = await runAsApiKey(PRINCIPAL, () => removeExceptionsCharged(["e1", "e2", "missing"], remover(2), deletedOf));
    expect(res.status).toBe(200);
    expect(m.count).toHaveBeenCalledWith({ where: { id: { in: ["e1", "e2", "missing"] }, userId: "user-1" } });
    expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 98 });
  });

  it("answers 429 with Retry-After once the hour's budget is spent, removing and charging nothing", async () => {
    for (let i = 0; i < 4; i++) reserveApiDestructive(25);
    m.count.mockResolvedValue(1);
    const remove = remover(1);
    const res = await runAsApiKey(PRINCIPAL, () => removeExceptionsCharged(["e1"], remove, deletedOf));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 0 });
  });

  it("lets a removal that matches nothing through without a charge", async () => {
    for (let i = 0; i < 4; i++) reserveApiDestructive(25);
    m.count.mockResolvedValue(0);
    const res = await runAsApiKey(PRINCIPAL, () => removeExceptionsCharged(["missing"], remover(0), deletedOf));
    expect(res.status).toBe(200);
  });

  it("gives back what was already gone when the delete ran (an overlapping request removed it)", async () => {
    m.count.mockResolvedValue(3);
    await runAsApiKey(PRINCIPAL, () => removeExceptionsCharged(["e1", "e2", "e3"], remover(1), deletedOf));
    expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 99 });
  });

  it("gives everything back when the removal fails or throws", async () => {
    m.count.mockResolvedValue(1);
    await runAsApiKey(PRINCIPAL, () => removeExceptionsCharged(["e1"], remover(0, 404), deletedOf));
    await expect(
      runAsApiKey(PRINCIPAL, () =>
        removeExceptionsCharged(["e1"], async () => { throw new Error("db down"); }, deletedOf),
      ),
    ).rejects.toThrow("db down");
    expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 100 });
  });
});
