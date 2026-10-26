/**
 * Initial-letter avatars for media-server and Seerr users: one colour per
 * name, the same wherever the name appears.
 */

export const AVATAR_PALETTE = [
  "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  "bg-teal-500/15 text-teal-300 ring-teal-500/30",
  "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30",
  "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30",
  "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
] as const;

/** A non-negative 32-bit string hash (Java's `hashCode`, absolute). Stable across sessions. */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The palette entry for `name`. */
export function avatarColor(name: string): string {
  return AVATAR_PALETTE[hashString(name) % AVATAR_PALETTE.length];
}

/** The letter an avatar shows: the name's first character, upper-cased, or "?". */
export function avatarInitial(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}
