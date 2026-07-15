import WebSocket, { type RawData } from "ws";
import type { MediaServerType } from "@/generated/prisma/client";

/**
 * Minimal transport interface the connection layer depends on, so unit tests
 * can inject a fake socket instead of opening a real WebSocket.
 */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  ping(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

export type SocketFactory = (
  url: string,
  options: { rejectUnauthorized: boolean; headers?: Record<string, string> },
) => RealtimeSocket;

/** Convert an http(s) base URL to a ws(s) URL, stripping trailing slashes. */
export function toWsBase(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return "wss://" + trimmed.slice("https://".length);
  if (trimmed.startsWith("http://")) return "ws://" + trimmed.slice("http://".length);
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) return trimmed;
  // Bare host — default to plaintext ws (LAN media servers are commonly http).
  return "ws://" + trimmed;
}

/**
 * Build the per-server realtime WebSocket URL. The access token is passed as a
 * query parameter (the form every server accepts for its notification socket)
 * and also, belt-and-suspenders, as a header by the caller.
 */
export function buildRealtimeUrl(type: MediaServerType, url: string, token: string): string {
  const wsBase = toWsBase(url);
  switch (type) {
    case "PLEX":
      return `${wsBase}/:/websockets/notifications?X-Plex-Token=${encodeURIComponent(token)}`;
    case "JELLYFIN":
      return `${wsBase}/socket?api_key=${encodeURIComponent(token)}&deviceId=librariarr`;
    case "EMBY":
      return `${wsBase}/embywebsocket?api_key=${encodeURIComponent(token)}&deviceId=librariarr`;
    default:
      throw new Error(`Unsupported media server type for realtime: ${type}`);
  }
}

/** Auth headers sent on the handshake alongside the query-param token. */
export function buildRealtimeHeaders(type: MediaServerType, token: string): Record<string, string> {
  switch (type) {
    case "PLEX":
      return { "X-Plex-Token": token, "X-Plex-Client-Identifier": "librariarr" };
    case "JELLYFIN":
      return {
        Authorization: `MediaBrowser Client="Librariarr", Device="Server", DeviceId="librariarr", Version="1.0.0", Token="${token}"`,
      };
    case "EMBY":
      return { "X-Emby-Token": token };
    default:
      return {};
  }
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return (data as Buffer).toString("utf8");
}

/** Production socket factory backed by the `ws` package. */
export const wsSocketFactory: SocketFactory = (url, options) => {
  const socket = new WebSocket(url, {
    rejectUnauthorized: options.rejectUnauthorized,
    headers: options.headers,
    handshakeTimeout: 15_000,
  });

  return {
    send: (data) => {
      try {
        socket.send(data);
      } catch {
        // Socket not open (racing a close) — drop the frame.
      }
    },
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closing/closed.
      }
    },
    ping: () => {
      try {
        socket.ping();
      } catch {
        // Not open — the keepalive interval will be torn down on close.
      }
    },
    onOpen: (cb) => socket.on("open", cb),
    onMessage: (cb) => socket.on("message", (data: RawData) => cb(rawToString(data))),
    onClose: (cb) =>
      socket.on("close", (code: number, reason: Buffer) => cb(code, reason?.toString?.("utf8") ?? "")),
    onError: (cb) => socket.on("error", cb),
  };
};
