import axios from "axios";

const TOKEN_RE = /X-Plex-Token=[^&\s"]+/gi;

/** Mask any X-Plex-Token Plex may echo back in an error body. */
function scrubToken(s: string): string {
  return s.replace(TOKEN_RE, "X-Plex-Token=***");
}

/**
 * Turn a failed Plex request into `METHOD /path → HTTP <status>: <detail>`.
 *
 * Plex answers a bad request (e.g. a collection write with stale rating keys)
 * with a bare 400 whose axios message is just "Request failed with status code
 * 400" — useless for telling which call failed or why. This names the method,
 * path, status, and Plex's own error body. The query string is stripped and any
 * echoed `X-Plex-Token` masked so tokens never reach the logs.
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
      // Skip HTML error pages (reverse-proxy 400/502s) — they bloat the log
      // without adding signal. Same policy as IntegrationError.
      const trimmed = data.trim();
      body = trimmed.startsWith("<") ? null : trimmed;
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
