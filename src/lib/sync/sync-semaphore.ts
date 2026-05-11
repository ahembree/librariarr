/**
 * Global sync concurrency limiter.
 * Prevents multiple simultaneous syncs from causing OOM by queuing
 * excess sync requests. Only one sync runs at a time.
 */

const MAX_CONCURRENT_SYNCS = 1;

let activeSyncs = 0;
const waitQueue: Array<() => void> = [];

export async function acquireSyncSlot(): Promise<void> {
  if (activeSyncs < MAX_CONCURRENT_SYNCS) {
    activeSyncs++;
    return;
  }
  // The releaser will hand off the slot directly — we inherit its count and
  // do NOT increment activeSyncs again on resume. This avoids a race where
  // a fresh caller observes activeSyncs=0 in the microtask gap between
  // release decrementing and the queued waiter resuming.
  await new Promise<void>((resolve) => {
    waitQueue.push(resolve);
  });
}

export function releaseSyncSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    next();
  } else {
    activeSyncs--;
  }
}
