import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { wsSocketFactory, buildRealtimeUrl, buildRealtimeHeaders } from "@/lib/media-server/realtime/socket";

// Drives the production `ws`-backed factory against a real local WebSocket
// server: handshake headers, text and binary frames, ping, client close.

let wss: WebSocketServer | null = null;

afterEach(async () => {
  if (wss) {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
  }
  wss = null;
});

async function startServer(): Promise<{
  port: number;
  connected: Promise<{ socket: ServerSocket; req: IncomingMessage }>;
}> {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss!.once("listening", () => resolve()));
  const connected = new Promise<{ socket: ServerSocket; req: IncomingMessage }>((resolve) =>
    wss!.once("connection", (socket, req) => resolve({ socket, req })),
  );
  return { port: (wss.address() as AddressInfo).port, connected };
}

describe("wsSocketFactory", () => {
  it("opens with the auth headers, receives text and binary frames as strings, and sends", async () => {
    const { port, connected } = await startServer();
    const url = buildRealtimeUrl("EMBY", `http://127.0.0.1:${port}`, "tok");
    const sock = wsSocketFactory(url, { rejectUnauthorized: true, headers: buildRealtimeHeaders("EMBY", "tok") });

    const messages: string[] = [];
    const gotTwo = new Promise<void>((resolve) =>
      sock.onMessage((m) => {
        messages.push(m);
        if (messages.length === 2) resolve();
      }),
    );
    const opened = new Promise<void>((resolve) => sock.onOpen(resolve));

    const { socket: serverSide, req } = await connected;
    await opened;
    expect(req.url).toBe("/embywebsocket?api_key=tok&deviceId=librariarr");
    expect(req.headers["x-emby-token"]).toBe("tok");

    const received = new Promise<string>((resolve) => serverSide.once("message", (d) => resolve(d.toString())));
    const pinged = new Promise<void>((resolve) => serverSide.once("ping", () => resolve()));
    sock.send('{"MessageType":"SessionsStart"}');
    sock.ping();
    expect(await received).toBe('{"MessageType":"SessionsStart"}');
    await pinged;

    serverSide.send("hello");
    serverSide.send(Buffer.from("biné", "utf8"), { binary: true });
    await gotTwo;
    expect(messages).toEqual(["hello", "biné"]);

    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      sock.onClose((code, reason) => resolve({ code, reason })),
    );
    serverSide.close(4001, "bye");
    expect(await closed).toEqual({ code: 4001, reason: "bye" });

    // Sending, pinging and closing after the socket has gone never throws.
    expect(() => sock.send("late")).not.toThrow();
    expect(() => sock.ping()).not.toThrow();
    expect(() => sock.close()).not.toThrow();
  });

  it("reports a failed handshake through onError and onClose", async () => {
    const { port } = await startServer();
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
    wss = null;
    const sock = wsSocketFactory(`ws://127.0.0.1:${port}/socket`, { rejectUnauthorized: false });
    const errP = new Promise<Error>((resolve) => sock.onError(resolve));
    const codeP = new Promise<number>((resolve) => sock.onClose((c) => resolve(c)));
    expect(await errP).toBeInstanceOf(Error);
    expect(await codeP).toBe(1006);
  });

  it("swallows send/ping on a socket that has not opened yet, and close while connecting", async () => {
    const { port } = await startServer();
    const sock = wsSocketFactory(`ws://127.0.0.1:${port}/x`, { rejectUnauthorized: true });
    // ws throws synchronously from send/ping while CONNECTING; the wrapper drops it.
    expect(() => sock.send("early")).not.toThrow();
    expect(() => sock.ping()).not.toThrow();
    const closed = new Promise<void>((resolve) => sock.onClose(() => resolve()));
    sock.onError(() => {});
    expect(() => sock.close()).not.toThrow();
    await closed;
  });
});
