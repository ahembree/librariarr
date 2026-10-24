import type { BundledResponse } from "@/lib/settings/settings-bundle-paths";

export interface RequestBundle {
  /**
   * `GET path`. The first request for a bundled path is answered from the one
   * bundle request (started on first use); every later one, and any path
   * outside the bundle, goes to the route itself. A bundle that cannot be
   * read, or that lacks the path, falls back to the route too.
   */
  get(path: string): Promise<Response>;
}

/**
 * The client half of `GET /api/settings/bundle`: the page's own fetchers keep
 * asking for their routes, and their opening reads are served from one
 * request. A fresh bundle per page mount, so a revisit reads current values.
 */
export function createRequestBundle(bundleUrl: string, paths: readonly string[]): RequestBundle {
  const unread = new Set(paths);
  let bundle: Promise<Record<string, BundledResponse> | null> | null = null;
  const load = () =>
    (bundle ??= fetch(`${bundleUrl}?paths=${encodeURIComponent(paths.join(","))}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ parts?: Record<string, BundledResponse> }>) : null))
      .then((data) => data?.parts ?? null)
      .catch(() => null));

  return {
    async get(path) {
      if (!unread.has(path)) return fetch(path);
      unread.delete(path);
      const part = (await load())?.[path];
      if (!part) return fetch(path);
      // A status that carries no body (204 and the like) cannot be given one.
      const bodiless = part.status === 204 || part.status === 205 || part.status === 304;
      return new Response(bodiless ? null : JSON.stringify(part.body), {
        status: part.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}
