/**
 * `url` without its trailing slashes ("http://host:7878//" → "http://host:7878").
 *
 * Instance URLs are stored and compared without them, base URLs are joined to
 * paths that start with one, and an issuer is matched with them ignored.
 * Client-safe.
 */
export function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}
