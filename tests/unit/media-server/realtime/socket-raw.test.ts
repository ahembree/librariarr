import { describe, it, expect, vi, beforeEach } from "vitest";

// rawToString's array (fragments) and ArrayBuffer branches only arise with a
// non-default binaryType, so they are driven through a fake `ws` here.

const { instances } = vi.hoisted(() => ({ instances: [] as Array<FakeWs> }));

interface FakeWs {
  url: string;
  opts: Record<string, unknown>;
  handlers: Record<string, (...args: unknown[]) => void>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
}

vi.mock("ws", () => {
  const FakeWebSocket = vi.fn(function (this: FakeWs, url: string, opts: Record<string, unknown>) {
    this.url = url;
    this.opts = opts;
    this.handlers = {};
    this.send = vi.fn();
    this.close = vi.fn();
    this.ping = vi.fn();
    (this as unknown as { on: (e: string, cb: (...a: unknown[]) => void) => void }).on = (e, cb) => {
      this.handlers[e] = cb;
    };
    instances.push(this);
  });
  return { default: FakeWebSocket };
});

import { wsSocketFactory } from "@/lib/media-server/realtime/socket";

beforeEach(() => {
  instances.length = 0;
});

describe("wsSocketFactory (fake ws)", () => {
  it("passes TLS, headers and a handshake timeout to ws", () => {
    wsSocketFactory("wss://h/socket", { rejectUnauthorized: false, headers: { A: "b" } });
    expect(instances[0].url).toBe("wss://h/socket");
    expect(instances[0].opts).toEqual({ rejectUnauthorized: false, headers: { A: "b" }, handshakeTimeout: 15_000 });
  });

  it("converts every RawData shape to a UTF-8 string", () => {
    const sock = wsSocketFactory("ws://h", { rejectUnauthorized: true });
    const got: string[] = [];
    sock.onMessage((m) => got.push(m));
    const emit = instances[0].handlers.message;
    emit("plain");
    emit(Buffer.from("buf"));
    emit([Buffer.from("frag"), Buffer.from("ments")]);
    const ab = new TextEncoder().encode("arraybuf").buffer;
    emit(ab);
    expect(got).toEqual(["plain", "buf", "fragments", "arraybuf"]);
  });

  it("passes an absent close reason as an empty string", () => {
    const sock = wsSocketFactory("ws://h", { rejectUnauthorized: true });
    const calls: Array<[number, string]> = [];
    sock.onClose((c, r) => calls.push([c, r]));
    instances[0].handlers.close(1000, undefined);
    instances[0].handlers.close(1001, Buffer.from("going away"));
    expect(calls).toEqual([
      [1000, ""],
      [1001, "going away"],
    ]);
  });

  it("swallows throws from send, ping and close", () => {
    const sock = wsSocketFactory("ws://h", { rejectUnauthorized: true });
    const ws = instances[0];
    ws.send.mockImplementation(() => {
      throw new Error("not open");
    });
    ws.ping.mockImplementation(() => {
      throw new Error("not open");
    });
    ws.close.mockImplementation(() => {
      throw new Error("closed");
    });
    expect(() => sock.send("x")).not.toThrow();
    expect(() => sock.ping()).not.toThrow();
    expect(() => sock.close()).not.toThrow();
    expect(ws.send).toHaveBeenCalledWith("x");
  });

  it("wires open and error handlers through", () => {
    const sock = wsSocketFactory("ws://h", { rejectUnauthorized: true });
    const onOpen = vi.fn();
    const onError = vi.fn();
    sock.onOpen(onOpen);
    sock.onError(onError);
    instances[0].handlers.open();
    const e = new Error("x");
    instances[0].handlers.error(e);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(e);
  });
});
