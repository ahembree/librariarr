/**
 * Each integration's identity colour, as Tailwind classes over the `app-*`
 * tokens in globals.css. The one place the Sonarr / Radarr / Lidarr / Seerr /
 * Tracearr colours live: the settings sections, the Arr and Seerr cards on a
 * detail page and anything else naming an integration read them from here.
 * Identity, not status — a Radarr dot is amber-ish because Radarr is, not
 * because anything is pending.
 */

export type IntegrationApp = "sonarr" | "radarr" | "lidarr" | "seerr" | "tracearr";

export interface IntegrationAppStyle {
  /** Text and icon colour. */
  text: string;
  /** The small indicator dot, with its glow. */
  dot: string;
  /** A tinted tile or icon well. */
  tile: string;
  /** A tinted border. */
  border: string;
}

export const INTEGRATION_APP_STYLES: Record<IntegrationApp, IntegrationAppStyle> = {
  sonarr: {
    text: "text-app-sonarr",
    dot: "bg-app-sonarr shadow-[0_0_6px] shadow-app-sonarr/60",
    tile: "bg-app-sonarr/10",
    border: "border-app-sonarr/30",
  },
  radarr: {
    text: "text-app-radarr",
    dot: "bg-app-radarr shadow-[0_0_6px] shadow-app-radarr/60",
    tile: "bg-app-radarr/10",
    border: "border-app-radarr/30",
  },
  lidarr: {
    text: "text-app-lidarr",
    dot: "bg-app-lidarr shadow-[0_0_6px] shadow-app-lidarr/60",
    tile: "bg-app-lidarr/10",
    border: "border-app-lidarr/30",
  },
  seerr: {
    text: "text-app-seerr",
    dot: "bg-app-seerr shadow-[0_0_6px] shadow-app-seerr/60",
    tile: "bg-app-seerr/10",
    border: "border-app-seerr/30",
  },
  tracearr: {
    text: "text-app-tracearr",
    dot: "bg-app-tracearr shadow-[0_0_6px] shadow-app-tracearr/60",
    tile: "bg-app-tracearr/10",
    border: "border-app-tracearr/30",
  },
};
