import { describe, it, expect, vi } from "vitest";

// Re-create a fresh instance for each test by importing the class directly
// rather than using the singleton (which persists across tests via globalThis)
const createEventBus = async () => {
  // Dynamic import to get the module
  const mod = await import("@/lib/events/event-bus");
  return mod;
};

describe("AppEventBus", () => {
  // Since the singleton lives on globalThis, we test via the exported eventBus
  // Each test should clean up its subscriptions

  it("delivers events to subscribers", async () => {
    const { eventBus } = await createEventBus();
    const listener = vi.fn();
    const unsubscribe = eventBus.subscribe(listener);

    eventBus.emit({ type: "sync:completed", userId: "user1" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sync:completed",
        userId: "user1",
        timestamp: expect.any(Number),
      }),
    );

    unsubscribe();
  });

  it("includes meta in delivered events", async () => {
    const { eventBus } = await createEventBus();
    const listener = vi.fn();
    const unsubscribe = eventBus.subscribe(listener);

    eventBus.emit({ type: "sync:started", userId: "user1", meta: { serverId: "server1" } });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sync:started",
        userId: "user1",
        meta: { serverId: "server1" },
      }),
    );

    unsubscribe();
  });

  it("does not deliver events after unsubscribe", async () => {
    const { eventBus } = await createEventBus();
    const listener = vi.fn();
    const unsubscribe = eventBus.subscribe(listener);

    eventBus.emit({ type: "sync:completed", userId: "user1" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    eventBus.emit({ type: "sync:completed", userId: "user1" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports multiple concurrent subscribers", async () => {
    const { eventBus } = await createEventBus();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = eventBus.subscribe(listener1);
    const unsub2 = eventBus.subscribe(listener2);

    eventBus.emit({ type: "lifecycle:detection-completed", userId: "user1" });

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
  });

  it("unsubscribing one listener does not affect others", async () => {
    const { eventBus } = await createEventBus();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = eventBus.subscribe(listener1);
    const unsub2 = eventBus.subscribe(listener2);

    unsub1();

    eventBus.emit({ type: "sync:completed", userId: "user1" });

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalledTimes(1);

    unsub2();
  });

  it("emit never throws even if a listener throws", async () => {
    const { eventBus } = await createEventBus();
    const badListener = vi.fn(() => {
      throw new Error("listener error");
    });
    const goodListener = vi.fn();
    const unsub1 = eventBus.subscribe(badListener);
    const unsub2 = eventBus.subscribe(goodListener);

    // emit wraps in try-catch, but EventEmitter calls listeners synchronously
    // If the first listener throws, the second may not be called
    // The important thing is that emit() itself doesn't throw
    expect(() => {
      eventBus.emit({ type: "sync:completed", userId: "user1" });
    }).not.toThrow();

    unsub1();
    unsub2();
  });

  it("adds a timestamp to emitted events", async () => {
    const { eventBus } = await createEventBus();
    const listener = vi.fn();
    const unsubscribe = eventBus.subscribe(listener);

    const before = Date.now();
    eventBus.emit({ type: "sync:completed", userId: "user1" });
    const after = Date.now();

    const event = listener.mock.calls[0][0];
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);

    unsubscribe();
  });

  it("tracks listener count", async () => {
    const { eventBus } = await createEventBus();
    const initialCount = eventBus.listenerCount;

    const unsub1 = eventBus.subscribe(vi.fn());
    expect(eventBus.listenerCount).toBe(initialCount + 1);

    const unsub2 = eventBus.subscribe(vi.fn());
    expect(eventBus.listenerCount).toBe(initialCount + 2);

    unsub1();
    expect(eventBus.listenerCount).toBe(initialCount + 1);

    unsub2();
    expect(eventBus.listenerCount).toBe(initialCount);
  });

  it("delivers all event types correctly", async () => {
    const { eventBus } = await createEventBus();
    const listener = vi.fn();
    const unsubscribe = eventBus.subscribe(listener);

    const types = [
      "sync:started",
      "sync:completed",
      "sync:failed",
      "lifecycle:detection-completed",
      "lifecycle:action-executed",
      "settings:changed",
      "server:changed",
    ] as const;

    for (const type of types) {
      eventBus.emit({ type, userId: "user1" });
    }

    expect(listener).toHaveBeenCalledTimes(types.length);
    for (let i = 0; i < types.length; i++) {
      expect(listener.mock.calls[i][0].type).toBe(types[i]);
    }

    unsubscribe();
  });
});
