import type { AxiosRequestConfig } from "axios";

/**
 * Keeps a client's credential on the host it was configured for.
 *
 * Every integration and media-server client is an axios instance whose default
 * headers carry a stored secret (`X-Api-Key`, `X-Plex-Token`, `X-Emby-Token`,
 * a provider's `x-api-key`). Two axios defaults let that secret leave the
 * configured host:
 *
 *  - **An absolute URL as the request path replaces `baseURL`** and is sent
 *    with the instance's headers. Plex stores cast photos as absolute URLs
 *    (`https://metadata-static.plex.tv/…`), so the artwork fallback handed the
 *    server's token to whatever host a metadata field named.
 *  - **A redirect to another origin keeps custom headers.** Only
 *    `Authorization` and `Cookie` are dropped on a host change; an instance
 *    behind a sign-in portal that answers 302 to its login page sent the key
 *    there.
 *
 * Spread the result into `axios.create`.
 */
export const CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
  "x-plex-token",
  "x-emby-token",
  "x-emby-authorization",
  "x-mediabrowser-token",
] as const;

const CREDENTIAL_HEADER_SET = new Set<string>(CREDENTIAL_HEADERS);

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/**
 * Whether a redirect target may still receive the credential: the configured
 * origin itself, or the same host answering "use https" — the ordinary reverse
 * proxy upgrade, on the same port or from the default http port to the default
 * https one. Anything else (another host, another port, a downgrade to http)
 * is a different party.
 */
export function redirectKeepsCredentials(baseURL: string, targetHref: string): boolean {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseURL);
    target = new URL(targetHref);
  } catch {
    return false;
  }
  if (base.hostname.toLowerCase() !== target.hostname.toLowerCase()) return false;
  const basePort = effectivePort(base);
  const targetPort = effectivePort(target);
  if (base.protocol === target.protocol) return basePort === targetPort;
  if (base.protocol === "http:" && target.protocol === "https:") {
    return basePort === targetPort || (basePort === "80" && targetPort === "443");
  }
  return false;
}

/** Remove every credential header, whatever its case, from a header bag. */
export function stripCredentialHeaders(headers: Record<string, unknown> | undefined | null): void {
  if (!headers) return;
  for (const name of Object.keys(headers)) {
    if (CREDENTIAL_HEADER_SET.has(name.toLowerCase())) delete headers[name];
  }
}

type RedirectOptions = { href?: string; headers?: Record<string, unknown> };

/**
 * The axios options that confine an instance's credential to `baseURL`:
 * absolute request URLs are joined to the base instead of replacing it, and a
 * redirect that leaves the configured origin continues without the credential
 * (judged against the configured origin on every hop, so a chain that wanders
 * off and back does not regain it by accident — the headers are already gone).
 */
export function confineCredentials(
  baseURL: string,
): Pick<AxiosRequestConfig, "allowAbsoluteUrls" | "beforeRedirect"> {
  return {
    allowAbsoluteUrls: false,
    beforeRedirect: (options: RedirectOptions) => {
      if (!options.href || !redirectKeepsCredentials(baseURL, options.href)) {
        stripCredentialHeaders(options.headers);
      }
    },
  };
}

/**
 * Keep a failed request's transport objects out of anything that prints the
 * error.
 *
 * An AxiosError carries `config` (the request headers, credential included),
 * `request` (the raw header block, credential included) and `response` as
 * enumerable properties, so `console.error(error)` — which is what Next.js
 * does with an error a route handler lets escape — writes the server's token
 * into the container log. Marking them non-enumerable leaves every reader
 * (`error.config`, `error.response?.status`, `axios.isAxiosError`, the retry)
 * working and takes them out of `util.inspect`.
 */
export function hideTransportDetails(error: unknown): void {
  if (!error || typeof error !== "object") return;
  for (const key of ["config", "request", "response"] as const) {
    if (Object.prototype.propertyIsEnumerable.call(error, key)) {
      Object.defineProperty(error, key, { enumerable: false });
    }
  }
}
