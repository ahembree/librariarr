import { describe, it, expect, beforeEach } from "vitest";
import {
  reserveApiDestructive,
  resetApiDestructiveBudget,
  destructiveRefusalResponse,
} from "@/lib/api-keys/destructive-budget";
import {
  API_DESTRUCTIVE_PER_HOUR,
  API_DESTRUCTIVE_PER_REQUEST,
  API_DESTRUCTIVE_WINDOW_MS,
} from "@/lib/api-keys/limits";

const T0 = 1_700_000_000_000;

describe("the public API's destructive budget", () => {
  beforeEach(() => resetApiDestructiveBudget());

  it("is 25 per request and 100 per rolling hour", () => {
    expect(API_DESTRUCTIVE_PER_REQUEST).toBe(25);
    expect(API_DESTRUCTIVE_PER_HOUR).toBe(100);
    expect(API_DESTRUCTIVE_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it("refuses a request over the per-request cap outright, and charges nothing", () => {
    const r = reserveApiDestructive(API_DESTRUCTIVE_PER_REQUEST + 1, T0);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(reserveApiDestructive(0, T0)).toMatchObject({ ok: true, remaining: API_DESTRUCTIVE_PER_HOUR });
  });

  it("allows exactly the hourly budget, then refuses with the wait until it fits", () => {
    for (let i = 0; i < 4; i++) {
      expect(reserveApiDestructive(25, T0 + i * 60_000)).toMatchObject({ ok: true });
    }
    const refused = reserveApiDestructive(1, T0 + 5 * 60_000);
    expect(refused).toMatchObject({ ok: false, status: 429 });
    // The first spend (at T0) is the one that has to age out.
    if (refused.ok || refused.status !== 429) throw new Error("expected a 429");
    expect(refused.retryAfterSeconds).toBe((API_DESTRUCTIVE_WINDOW_MS - 5 * 60_000) / 1000);
    expect(refused.error).toMatch(/0 remain/);
  });

  it("refuses a request that would cross the limit, even when some budget remains", () => {
    expect(reserveApiDestructive(25, T0)).toMatchObject({ ok: true, remaining: 75 });
    expect(reserveApiDestructive(25, T0)).toMatchObject({ ok: true, remaining: 50 });
    expect(reserveApiDestructive(25, T0)).toMatchObject({ ok: true, remaining: 25 });
    expect(reserveApiDestructive(20, T0)).toMatchObject({ ok: true, remaining: 5 });
    const refused = reserveApiDestructive(6, T0);
    expect(refused).toMatchObject({ ok: false, status: 429 });
    // A refusal charges nothing: the 5 that remain are still there.
    expect(reserveApiDestructive(5, T0)).toMatchObject({ ok: true, remaining: 0 });
  });

  it("frees budget as spends age out of the window — a rolling hour, not a clock hour", () => {
    expect(reserveApiDestructive(25, T0)).toMatchObject({ ok: true });
    expect(reserveApiDestructive(25, T0 + 30 * 60_000)).toMatchObject({ ok: true });
    expect(reserveApiDestructive(25, T0 + 40 * 60_000)).toMatchObject({ ok: true });
    expect(reserveApiDestructive(25, T0 + 50 * 60_000)).toMatchObject({ ok: true });
    // Just before the first spend ages out: still full.
    expect(reserveApiDestructive(1, T0 + API_DESTRUCTIVE_WINDOW_MS - 1)).toMatchObject({ ok: false, status: 429 });
    // Once it has: exactly its 25 are free again, no more.
    expect(reserveApiDestructive(25, T0 + API_DESTRUCTIVE_WINDOW_MS)).toMatchObject({ ok: true, remaining: 0 });
  });

  it("names, in Retry-After, the moment enough of the oldest spends have aged out", () => {
    reserveApiDestructive(10, T0);
    reserveApiDestructive(25, T0 + 10 * 60_000);
    reserveApiDestructive(25, T0 + 20 * 60_000);
    reserveApiDestructive(25, T0 + 30 * 60_000);
    reserveApiDestructive(15, T0 + 40 * 60_000);
    // Full. 20 more needs the 10 at T0 AND the 25 at +10min to age out.
    const refused = reserveApiDestructive(20, T0 + 45 * 60_000);
    if (refused.ok || refused.status !== 429) throw new Error("expected a 429");
    expect(refused.retryAfterSeconds).toBe((10 * 60_000 + API_DESTRUCTIVE_WINDOW_MS - 45 * 60_000) / 1000);
  });

  it("is one budget however many module instances load it (pinned to globalThis)", async () => {
    reserveApiDestructive(25, T0);
    const { vi } = await import("vitest");
    vi.resetModules();
    const fresh = await import("@/lib/api-keys/destructive-budget");
    expect(fresh.reserveApiDestructive(0, T0)).toMatchObject({ ok: true, remaining: 75 });
  });

  it("gives back, through release, only what the reservation charged and never below zero", () => {
    const first = reserveApiDestructive(25, T0);
    const second = reserveApiDestructive(10, T0);
    if (!first.ok || !second.ok) throw new Error("expected both to fit");
    first.release(5);
    expect(reserveApiDestructive(0, T0)).toMatchObject({ ok: true, remaining: 100 - 20 - 10 });
    // Releasing more than was reserved frees this reservation, not another's.
    second.release(50);
    first.release(50);
    expect(reserveApiDestructive(0, T0)).toMatchObject({ ok: true, remaining: 100 });
    // A release of nothing, or of a reservation of nothing, changes nothing.
    first.release(0);
    const nothing = reserveApiDestructive(0, T0);
    if (!nothing.ok) throw new Error("a reservation of nothing always fits");
    nothing.release(3);
    expect(reserveApiDestructive(0, T0)).toMatchObject({ ok: true, remaining: 100 });
  });

  it("lets a released amount be spent again within the same hour", () => {
    for (let i = 0; i < 3; i++) reserveApiDestructive(25, T0);
    const last = reserveApiDestructive(25, T0);
    if (!last.ok) throw new Error("expected it to fit");
    expect(reserveApiDestructive(1, T0)).toMatchObject({ ok: false, status: 429 });
    last.release(25);
    expect(reserveApiDestructive(25, T0 + 1000)).toMatchObject({ ok: true, remaining: 0 });
  });

  it("answers a 429 with Retry-After and a 400 without", async () => {
    const tooMany = destructiveRefusalResponse({ ok: false, status: 429, error: "slow down", retryAfterSeconds: 42 });
    expect(tooMany.status).toBe(429);
    expect(tooMany.headers.get("retry-after")).toBe("42");
    expect(await tooMany.json()).toEqual({ error: "slow down" });

    const tooBig = destructiveRefusalResponse({ ok: false, status: 400, error: "too big" });
    expect(tooBig.status).toBe(400);
    expect(tooBig.headers.get("retry-after")).toBeNull();
  });
});
