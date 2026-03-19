export const SERVER_TYPE_STYLES: Record<
  string,
  { label: string; classes: string; color: string }
> = {
  PLEX: {
    label: "Plex",
    classes: "text-orange-400 bg-orange-500/15 border-orange-500/30",
    color: "#fb923c",
  },
  JELLYFIN: {
    label: "Jellyfin",
    classes: "text-purple-400 bg-purple-500/15 border-purple-500/30",
    color: "#c084fc",
  },
  EMBY: {
    label: "Emby",
    classes: "text-emerald-400 bg-emerald-500/15 border-emerald-500/30",
    color: "#34d399",
  },
};

export const DEFAULT_SERVER_STYLE = {
  label: "Unknown",
  classes: "text-muted-foreground bg-muted border-border",
  color: "#a1a1aa",
};
