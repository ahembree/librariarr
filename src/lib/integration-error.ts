import axios, { type AxiosError } from "axios";

/**
 * A clean Error type that *arr / Seerr clients throw on any axios failure.
 *
 * Replacing AxiosError prevents the verbose multi-page dump that Next.js
 * emits when an unhandled rejection from a route handler propagates with an
 * AxiosError attached (full request config, response body, headers, stack).
 *
 * The original AxiosError is attached as `cause` so callers that need the
 * underlying status / response body (e.g. lifecycle action error extraction)
 * can still get to it — but the default printed form is a single line.
 */
export class IntegrationError extends Error {
  /** Service that failed: "Sonarr", "Radarr", "Lidarr", "Seerr". */
  readonly service: string;
  /** HTTP status if a response was received; null for network-level failures. */
  readonly status: number | null;
  /** Best-effort detail extracted from the response body (HTTP errors only). */
  readonly detail: string | null;
  /** axios error code (ECONNREFUSED, ETIMEDOUT, ERR_BAD_RESPONSE, etc.). */
  readonly code: string;
  /** Path being requested when it failed. */
  readonly url: string;

  constructor(
    service: string,
    error: AxiosError,
  ) {
    const url = error.config?.url ?? "";
    const code = error.code ?? "ERR";
    const status = error.response?.status ?? null;

    let detail: string | null = null;
    if (status !== null) {
      const data = error.response?.data;
      if (typeof data === "string" && data.trim().length > 0) {
        detail = data.trim().slice(0, 200);
      } else if (data && typeof data === "object") {
        const obj = data as Record<string, unknown>;
        if (typeof obj.message === "string") detail = obj.message.slice(0, 200);
        else if (typeof obj.error === "string") detail = obj.error.slice(0, 200);
      }
    }

    const msg = status !== null
      ? `${service} HTTP ${status}${detail ? `: ${detail}` : ""}${url ? ` (${url})` : ""}`
      : `${service} unreachable${url ? ` (${url})` : ""}: ${code}`;

    super(msg, { cause: error });
    this.name = "IntegrationError";
    this.service = service;
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.url = url;
  }
}

/**
 * If the error is an axios error, wrap it in an `IntegrationError` so the
 * thrown rejection prints concisely. Otherwise pass it through unchanged.
 */
export function wrapAxiosError(service: string, error: unknown): unknown {
  if (axios.isAxiosError(error)) {
    return new IntegrationError(service, error);
  }
  return error;
}
