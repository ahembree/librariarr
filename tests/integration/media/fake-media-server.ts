/**
 * A local HTTP server standing in for a Plex, Jellyfin or Emby server, so a test drives the REAL
 * client (paging, axios instance, interceptors) and sync. Not a `.test.ts`: vitest never runs it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeResponse {
  status?: number;
  body: unknown;
}

/** Answers one request; may be async (e.g. to change the database mid-fetch). */
export type FakeRoute = (
  path: string,
  query: URLSearchParams,
) => FakeResponse | Promise<FakeResponse>;

export interface FakeMediaServer {
  url: string;
  /** Every request's path, in order. */
  requests: string[];
  /** Every request's raw URL (path and query string, as sent), in order. */
  urls: string[];
  close(): Promise<void>;
}

export async function startFakeMediaServer(route: FakeRoute): Promise<FakeMediaServer> {
  const requests: string[] = [];
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://fake");
    requests.push(parsed.pathname);
    urls.push(req.url ?? "/");
    req.resume();
    Promise.resolve()
      .then(() => route(parsed.pathname, parsed.searchParams))
      .then(
        ({ status = 200, body }) => {
          res.writeHead(status, {
            "Content-Type": typeof body === "string" ? "text/html" : "application/json",
          });
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        },
        (error: unknown) => {
          // A failing route is a test bug: answer a loud 418 (never retried) rather than hang.
          res.writeHead(418, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        },
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    urls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Jellyfin/Emby `/Users/{id}/Items` played-items answer, paged by StartIndex. */
export interface FakePlayedItem {
  Id: string;
  UserData: { PlayCount: number; LastPlayedDate?: string };
}

/** A Jellyfin/Emby route: `/Users`, and each user's played items (one full page, or a page function). */
export function jellyfinRoute(
  users: Record<
    string,
    FakePlayedItem[] | ((startIndex: number) => FakeResponse | Promise<FakeResponse>)
  >,
): FakeRoute {
  return (path, query) => {
    if (path === "/Users") {
      return { body: Object.keys(users).map((name) => ({ Id: `id-${name}`, Name: name })) };
    }
    const match = path.match(/^\/Users\/id-(.+)\/Items$/);
    const listing = match ? users[match[1]] : undefined;
    if (!listing) return { status: 404, body: { error: `no route for ${path}` } };
    const startIndex = Number(query.get("StartIndex") ?? 0);
    if (typeof listing === "function") return listing(startIndex);
    return {
      body: { Items: startIndex === 0 ? listing : [], TotalRecordCount: listing.length },
    };
  };
}
