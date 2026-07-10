import axios from "axios";

const TOKEN_RE = /X-Plex-Token=[^&\s"]+/gi;

/** Mask any X-Plex-Token Plex may echo back in an error body. */
function scrubToken(s: string): string {
  return s.replace(TOKEN_RE, "X-Plex-Token=***");
}

/**
 * Turn a failed Plex request into a diagnostic string that names the HTTP
 * method, the request path, the status code, and Plex's response body.
 *
 * Plex answers a bad collection write — e.g. a
 * `server://<machineId>/com.plexapp.plugins.library/library/metadata/<ratingKeys>`
 * URI it cannot resolve because the server's stored `machineId` is wrong or the
 * `ratingKeys` are stale (Plex regenerated them after a library rebuild) — with a
 * bare HTTP 400 whose only default message is "Request failed with status code
 * 400". That is useless for telling which of the half-dozen calls in
 * `syncCollection` failed or why, which is exactly how an empty-collection bug
 * stays invisible. This surfaces the missing detail. Any `X-Plex-Token` echoed
 * back by Plex is masked before it reaches the logs.
 */
export function describePlexError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? "NETWORK";
    const method = (error.config?.method ?? "?").toUpperCase();
    // Strip the query string (carries the token) — keep only the path.
    const path = (error.config?.url ?? "?").split("?")[0];
    const data = error.response?.data;
    let body: string | null = null;
    if (typeof data === "string") {
      body = data;
    } else if (data && typeof data === "object") {
      const message = (data as Record<string, unknown>).message;
      body = typeof message === "string" ? message : JSON.stringify(data);
    }
    if (body) body = scrubToken(body).slice(0, 500);
    return body
      ? `${method} ${path} → HTTP ${status}: ${body}`
      : `${method} ${path} → HTTP ${status} (${error.message})`;
  }
  return error instanceof Error ? error.message : String(error);
}
