export interface ServerStyle {
  label: string;
  /** Badge/chip Tailwind classes: text + bg + border */
  classes: string;
  /** Solid hex color for charts/swatches */
  color: string;
  /** rgba variants for inline styles (play buttons, overlays) */
  rgba: { bg: string; hover: string; text: string };
  /** Onboarding card Tailwind classes */
  onboarding: {
    iconColor: string;
    borderColor: string;
    bgColor: string;
    hoverBg: string;
    glowColor: string;
  };
  /** Manual server form Tailwind classes (Jellyfin/Emby only) */
  manual?: {
    btn: string;
    btnHover: string;
    btnText: string;
    addedBg: string;
    addedText: string;
    addedBorder: string;
    border: string;
    glow: string;
  };
}

export const SERVER_TYPE_STYLES: Record<string, ServerStyle> = {
  PLEX: {
    label: "Plex",
    classes: "text-orange-400 bg-orange-500/15 border-orange-500/30",
    color: "#fb923c",
    rgba: { bg: "rgba(229,160,13,0.25)", hover: "rgba(229,160,13,0.4)", text: "rgba(229,160,13,0.95)" },
    onboarding: {
      iconColor: "text-orange-400",
      borderColor: "border-orange-500/30",
      bgColor: "bg-orange-500/10",
      hoverBg: "hover:bg-orange-500/15",
      glowColor: "bg-orange-500/5",
    },
  },
  JELLYFIN: {
    label: "Jellyfin",
    classes: "text-purple-400 bg-purple-500/15 border-purple-500/30",
    color: "#c084fc",
    rgba: { bg: "rgba(170,92,195,0.25)", hover: "rgba(170,92,195,0.4)", text: "rgba(170,92,195,0.95)" },
    onboarding: {
      iconColor: "text-purple-400",
      borderColor: "border-purple-500/30",
      bgColor: "bg-purple-500/10",
      hoverBg: "hover:bg-purple-500/15",
      glowColor: "bg-purple-500/5",
    },
    manual: {
      btn: "bg-purple-500", btnHover: "hover:bg-purple-600", btnText: "text-white",
      addedBg: "bg-purple-500/15", addedText: "text-purple-400", addedBorder: "border-purple-500/30",
      border: "border-purple-500/40", glow: "bg-purple-500/5",
    },
  },
  EMBY: {
    label: "Emby",
    classes: "text-emerald-400 bg-emerald-500/15 border-emerald-500/30",
    color: "#34d399",
    rgba: { bg: "rgba(82,181,75,0.25)", hover: "rgba(82,181,75,0.4)", text: "rgba(82,181,75,0.95)" },
    onboarding: {
      iconColor: "text-emerald-400",
      borderColor: "border-emerald-500/30",
      bgColor: "bg-emerald-500/10",
      hoverBg: "hover:bg-emerald-500/15",
      glowColor: "bg-emerald-500/5",
    },
    manual: {
      btn: "bg-emerald-500", btnHover: "hover:bg-emerald-600", btnText: "text-white",
      addedBg: "bg-emerald-500/15", addedText: "text-emerald-400", addedBorder: "border-emerald-500/30",
      border: "border-emerald-500/40", glow: "bg-emerald-500/5",
    },
  },
};

/**
 * Returns the human-readable label for a server type (e.g. "PLEX" → "Plex").
 */
export function getServerTypeLabel(type: string): string {
  return SERVER_TYPE_STYLES[type]?.label ?? type;
}

/**
 * Build a display-name map for a list of servers, appending the type label
 * in parentheses when two or more servers share the same name.
 * Returns a Map keyed by server id → display string.
 */
export function getServerDisplayNames<T extends { id: string; name: string; type?: string }>(
  servers: T[],
): Map<string, string> {
  const nameCounts = new Map<string, number>();
  for (const s of servers) {
    nameCounts.set(s.name, (nameCounts.get(s.name) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const s of servers) {
    const isDuplicate = (nameCounts.get(s.name) ?? 0) > 1;
    if (isDuplicate && s.type) {
      result.set(s.id, `${s.name} (${getServerTypeLabel(s.type)})`);
    } else {
      result.set(s.id, s.name);
    }
  }
  return result;
}

export const DEFAULT_SERVER_STYLE: ServerStyle = {
  label: "Unknown",
  classes: "text-muted-foreground bg-muted border-border",
  color: "#a1a1aa",
  rgba: { bg: "rgba(255,255,255,0.15)", hover: "rgba(255,255,255,0.25)", text: "rgba(255,255,255,0.9)" },
  onboarding: {
    iconColor: "text-muted-foreground",
    borderColor: "border-border",
    bgColor: "bg-muted",
    hoverBg: "hover:bg-muted/80",
    glowColor: "bg-muted/50",
  },
};
