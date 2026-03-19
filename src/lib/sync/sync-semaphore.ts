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
  await new Promise<void>((resolve) => {
    waitQueue.push(resolve);
  });
  activeSyncs++;
}

export function releaseSyncSlot(): void {
  activeSyncs--;
  const next = waitQueue.shift();
  if (next) next();
}
