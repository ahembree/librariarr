import { describe, it, expect, beforeEach, vi } from "vitest";

describe("sync-semaphore", () => {
  let acquireSyncSlot: typeof import("@/lib/sync/sync-semaphore").acquireSyncSlot;
  let releaseSyncSlot: typeof import("@/lib/sync/sync-semaphore").releaseSyncSlot;

  beforeEach(async () => {
    // Re-import with fresh module state each time
    vi.resetModules();
    const mod = await import("@/lib/sync/sync-semaphore");
    acquireSyncSlot = mod.acquireSyncSlot;
    releaseSyncSlot = mod.releaseSyncSlot;
  });

  it("allows the first sync to acquire immediately", async () => {
    await acquireSyncSlot();
    // Should resolve without blocking
    releaseSyncSlot();
  });

  it("blocks second sync until first is released", async () => {
    await acquireSyncSlot();

    let secondAcquired = false;
    const secondPromise = acquireSyncSlot().then(() => {
      secondAcquired = true;
    });

    // Yield to microtasks — second should NOT have acquired
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    // Release first slot
    releaseSyncSlot();

    // Now second should acquire
    await secondPromise;
    expect(secondAcquired).toBe(true);

    releaseSyncSlot();
  });

  it("queues multiple waiters and processes them in FIFO order", async () => {
    await acquireSyncSlot();

    const order: number[] = [];

    const p1 = acquireSyncSlot().then(() => {
      order.push(1);
    });
    const p2 = acquireSyncSlot().then(() => {
      order.push(2);
    });
    const p3 = acquireSyncSlot().then(() => {
      order.push(3);
    });

    // Release first — waiter 1 should acquire
    releaseSyncSlot();
    await p1;
    expect(order).toEqual([1]);

    // Release waiter 1 — waiter 2 should acquire
    releaseSyncSlot();
    await p2;
    expect(order).toEqual([1, 2]);

    // Release waiter 2 — waiter 3 should acquire
    releaseSyncSlot();
    await p3;
    expect(order).toEqual([1, 2, 3]);

    releaseSyncSlot();
  });

  it("allows re-acquisition after release", async () => {
    await acquireSyncSlot();
    releaseSyncSlot();

    // Should be able to acquire again
    await acquireSyncSlot();
    releaseSyncSlot();
  });

  it("release without pending waiters just decrements count", async () => {
    await acquireSyncSlot();
    releaseSyncSlot();

    // Should be able to acquire immediately again (slot freed)
    let acquired = false;
    const p = acquireSyncSlot().then(() => {
      acquired = true;
    });
    await p;
    expect(acquired).toBe(true);
    releaseSyncSlot();
  });

  it("handles rapid acquire-release cycles", async () => {
    for (let i = 0; i < 10; i++) {
      await acquireSyncSlot();
      releaseSyncSlot();
    }
    // Should complete without deadlocking
  });

  it("blocked acquires do not resolve until release is called", async () => {
    await acquireSyncSlot();

    let resolved = false;
    acquireSyncSlot().then(() => {
      resolved = true;
    });

    // Even after multiple microtask yields, should not resolve
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseSyncSlot();
    // Now yield for the promise to resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);

    releaseSyncSlot();
  });
});
