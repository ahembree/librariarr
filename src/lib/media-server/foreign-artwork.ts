import axios from "axios";
import net from "node:net";

/**
 * Artwork a media server names by an absolute URL on another host.
 *
 * Plex stores every cast photo that way (`https://metadata-static.plex.tv/…`)
 * and normally fetches it itself, through its photo transcoder. When that
 * fails, Librariarr fetches the picture directly — and must do so as a
 * stranger: the server's own axios client would add the server's token to the
 * request (see `src/lib/http-credentials.ts`).
 *
 * The URL comes from the media server's metadata, not from the admin, so it is
 * held to what a public picture needs: `https`, a DNS name (no IP literal, no
 * `localhost`, no single-label intranet name), an `image/*` answer of bounded
 * size, and the same test on every redirect. This narrows what a hostile
 * metadata field can make this host request; it is not a guarantee about where
 * a public name resolves.
 */

/** 25 MB — far above any poster or cast photo. */
const MAX_ARTWORK_BYTES = 25 * 1024 * 1024;

/** A path on the media server itself (`/library/metadata/1/thumb`), not a URL naming a host. */
export function isServerRelativePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

/** Whether `url` is a public-looking https address artwork may be fetched from. */
export function isFetchableArtworkUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  // `URL` keeps the brackets around an IPv6 literal.
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || net.isIP(host) !== 0) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (!host.includes(".")) return false;
  return true;
}

/** Fetch foreign artwork with no credential. Throws unless an image comes back. */
export async function fetchForeignArtwork(url: string): Promise<{ data: Buffer; contentType: string }> {
  if (!isFetchableArtworkUrl(url)) {
    throw new Error("Artwork URL is not a public https address");
  }
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    maxRedirects: 3,
    maxContentLength: MAX_ARTWORK_BYTES,
    headers: { Accept: "image/*" },
    beforeRedirect: (options: { href?: string }) => {
      if (!options.href || !isFetchableArtworkUrl(options.href)) {
        throw new Error("Artwork redirect is not a public https address");
      }
    },
  });
  const contentType = response.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("image/")) {
    throw new Error("Artwork URL did not answer with an image");
  }
  return { data: Buffer.from(response.data), contentType };
}
