/**
 * Global sync concurrency limiter.
 * Prevents multiple simultaneous syncs from causing OOM by queuing
 * excess sync requests. Only one sync runs at a time.
 */

const MAX_CONCURRENT_SYNCS = 1;

// Pinned to globalThis: a limiter that is "global" only within one module copy
// is not one. Every caller runs in the job worker today, but a production build
// gives a route bundle its own copy of this module, and a sync started from a
// request would otherwise run beside the worker's unserialized.
const globalForSyncSlots = globalThis as unknown as {
  syncSlots: { active: number; waitQueue: Array<() => void> } | undefined;
};
const slots = (globalForSyncSlots.syncSlots ??= { active: 0, waitQueue: [] });

export async function acquireSyncSlot(): Promise<void> {
  if (slots.active < MAX_CONCURRENT_SYNCS) {
    slots.active++;
    return;
  }
  // The releaser will hand off the slot directly — we inherit its count and
  // do NOT increment slots.active again on resume. This avoids a race where
  // a fresh caller observes slots.active=0 in the microtask gap between
  // release decrementing and the queued waiter resuming.
  await new Promise<void>((resolve) => {
    slots.waitQueue.push(resolve);
  });
}

export function releaseSyncSlot(): void {
  const next = slots.waitQueue.shift();
  if (next) {
    next();
  } else {
    slots.active--;
  }
}
