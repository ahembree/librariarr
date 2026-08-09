/**
 * Classifies a client endpoint reported by a media server as being on a
 * private (LAN-ish) network.
 *
 * Plex reports an explicit `Player.local` flag, but Jellyfin/Emby sessions
 * only carry `RemoteEndPoint` — an `"ip:port"` string that is populated for
 * LAN clients just as much as WAN ones. LAN vs WAN therefore has to be
 * inferred from the address itself.
 *
 * CGNAT space (100.64.0.0/10) counts as private here because that is where
 * Tailscale/Headscale overlays live, and a user on their own tailnet is not
 * what "Remote Transcoding" is meant to catch.
 *
 * An absent or unparseable address is NOT private — the predicate answers
 * "is this a private address?", and an address we cannot read is not one.
 */

/** Strips the `:port` suffix, handling bracketed IPv6 (`[::1]:8096`). */
function stripPort(endpoint: string): string {
  const trimmed = endpoint.trim();

  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed.slice(1) : trimmed.slice(1, close);
  }

  // A bare IPv6 literal has several colons and no port; only strip when there
  // is exactly one colon (`192.168.1.10:8096`).
  const firstColon = trimmed.indexOf(":");
  if (firstColon !== -1 && trimmed.indexOf(":", firstColon + 1) === -1) {
    return trimmed.slice(0, firstColon);
  }

  return trimmed;
}

export function isPrivateAddress(endpoint?: string | null): boolean {
  if (!endpoint) return false;

  let host = stripPort(endpoint);
  if (!host) return false;

  // Drop an IPv6 zone index ("fe80::1%eth0").
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  host = host.toLowerCase();

  // IPv4-mapped IPv6 ("::ffff:192.168.1.10") — classify by the IPv4 part.
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) host = mapped[1];

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    const [a, b] = octets;

    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / tailnet
    return false;
  }

  // Everything below is IPv6; a hostname must not fall through into the
  // prefix checks (e.g. "fd-cdn.example.com" is not a ULA).
  if (!host.includes(":")) return false;

  if (host === "::1") return true; // loopback

  const firstHextet = host.split(":")[0];
  if (/^f[cd]/.test(firstHextet)) return true; // fc00::/7 unique-local

  const value = parseInt(firstHextet, 16);
  if (!Number.isNaN(value) && value >= 0xfe80 && value <= 0xfebf) return true; // fe80::/10

  return false;
}
