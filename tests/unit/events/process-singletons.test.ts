import { describe, it, expect, vi, afterEach } from "vitest";

// The job worker and the realtime manager are started from instrumentation and
// load their own copy of every module they import; the route handlers load
// another. A singleton that only those two sides share must therefore live on
// globalThis in a PRODUCTION build — pinning it only in development (the usual
// HMR idiom) left the browser event stream, the sessions stream and the
// self-write registry each looking at an instance nothing else wrote to.
// `NODE_ENV` is stubbed to "production" because under "test" the old,
// development-only pin passed too.

const GLOBAL_KEYS = ["eventBus", "realtimeBus", "realtimeSelfWrites", "mediaServerFailures"] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadTwice<T>(load: () => Promise<T>): Promise<[T, T]> {
  vi.stubEnv("NODE_ENV", "production");
  for (const key of GLOBAL_KEYS) delete (globalThis as Record<string, unknown>)[key];
  vi.resetModules();
  const first = await load();
  vi.resetModules();
  const second = await load();
  return [first, second];
}

describe("singletons shared between instrumentation and routes", () => {
  it("eventBus: an event emitted by one copy reaches a subscriber on another", async () => {
    const [worker, route] = await loadTwice(async () => (await import("@/lib/events/event-bus")).eventBus);
    expect(route).toBe(worker);

    const received: string[] = [];
    const unsubscribe = route.subscribe((event) => received.push(event.type));
    worker.emit({ type: "server-status", userId: "u1", meta: { serverId: "s1", connected: false } });
    unsubscribe();
    expect(received).toEqual(["server-status"]);
  });

  it("realtimeBus: one instance however many times the module is loaded", async () => {
    const [manager, route] = await loadTwice(
      async () => (await import("@/lib/media-server/realtime/bus")).realtimeBus,
    );
    expect(route).toBe(manager);
  });

  it("self-write registry: a mark made through one copy is seen through another", async () => {
    const [writer, reader] = await loadTwice(() => import("@/lib/media-server/realtime/self-writes"));
    writer.markSelfWrites("server-1", ["rk-1"]);
    expect(reader.isSelfWrite("server-1", "rk-1")).toBe(true);
  });

  it("server health: a server the worker found down is down for the routes too", async () => {
    const [worker, route] = await loadTwice(() => import("@/lib/media-server/health-cache"));
    worker.markUnreachable("http://plex.lan:32400", new Error("ECONNREFUSED"));
    expect(route.isUnreachable("http://plex.lan:32400/")).toBe(true);
    route.clearUnreachable("http://plex.lan:32400");
    expect(worker.isUnreachable("http://plex.lan:32400")).toBe(false);
  });
});
