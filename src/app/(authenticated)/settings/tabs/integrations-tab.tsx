"use client";

import { memo } from "react";
import { Boxes, Inbox, History } from "lucide-react";
import type { IntegrationInstance, IntegrationType } from "../integration-instances";
import { useIntegrationInstances } from "../use-integration-instances";
import { IntegrationInstanceSection, type IntegrationSectionConfig } from "./integration-instance-section";

// ─── Per-type configuration ───

const ARR_EXTERNAL_URL_HINT = 'Used for "Open in" links. Falls back to URL above if empty.';

const SONARR: IntegrationSectionConfig = {
  type: "sonarr",
  label: "Sonarr",
  hasExternalUrl: true,
  testBeforeAdd: true,
  toggleNoun: "integration",
  icon: Boxes,
  style: {
    text: "text-sky-400",
    dot: "bg-sky-400 shadow-[0_0_6px] shadow-sky-400/60",
    tile: "bg-sky-500/10",
    border: "border-sky-500/30",
  },
  // deepcode ignore HardcodedNonCryptoSecret: Placeholder string
  placeholder: { name: "My Sonarr", url: "http://localhost:8989", apiKey: "API key from Sonarr settings" },
  addDescription: "Connection will be tested before saving.",
  emptyDescription: "Connect your Sonarr server to enable lifecycle matching and tag sync.",
  externalUrlHint: ARR_EXTERNAL_URL_HINT,
  gridClassName: "sm:grid-cols-2",
};

const RADARR: IntegrationSectionConfig = {
  ...SONARR,
  type: "radarr",
  label: "Radarr",
  style: {
    text: "text-amber-400",
    dot: "bg-amber-400 shadow-[0_0_6px] shadow-amber-400/60",
    tile: "bg-amber-500/10",
    border: "border-amber-500/30",
  },
  // deepcode ignore HardcodedNonCryptoSecret: Placeholder string
  placeholder: { name: "My Radarr", url: "http://localhost:7878", apiKey: "API key from Radarr settings" },
  emptyDescription: "Connect your Radarr server to enable lifecycle matching and tag sync.",
};

const LIDARR: IntegrationSectionConfig = {
  ...SONARR,
  type: "lidarr",
  label: "Lidarr",
  style: {
    text: "text-emerald-400",
    dot: "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/60",
    tile: "bg-emerald-500/10",
    border: "border-emerald-500/30",
  },
  // deepcode ignore HardcodedNonCryptoSecret: Placeholder string
  placeholder: { name: "My Lidarr", url: "http://localhost:8686", apiKey: "API key from Lidarr settings" },
  emptyDescription: "Connect your Lidarr server to enable lifecycle matching and tag sync.",
};

const SEERR: IntegrationSectionConfig = {
  type: "seerr",
  label: "Seerr",
  hasExternalUrl: true,
  testBeforeAdd: true,
  toggleNoun: "Seerr",
  icon: Inbox,
  style: {
    text: "text-violet-400",
    dot: "bg-violet-400 shadow-[0_0_6px] shadow-violet-400/60",
    tile: "bg-violet-500/10",
    border: "border-violet-500/30",
  },
  // deepcode ignore HardcodedNonCryptoSecret: Placeholder string
  placeholder: { name: "My Seerr", url: "http://localhost:5055", apiKey: "API key from Seerr settings" },
  addDescription: "Manage request integration instances.",
  emptyDescription: "Connect Overseerr or Jellyseerr to surface request data alongside your library.",
  externalUrlHint: 'Used for "Open in Seerr" links. Falls back to URL above if empty.',
  gridClassName: "sm:grid-cols-4",
};

/**
 * Tracearr has no unsaved-instance test endpoint (only
 * `POST /api/integrations/tracearr/[id]/test-connection`), so the add form has
 * no Test button — `POST /api/integrations/tracearr` verifies the connection
 * itself and returns the failure detail, which the form shows inline.
 */
const TRACEARR: IntegrationSectionConfig = {
  type: "tracearr",
  label: "Tracearr",
  hasExternalUrl: false,
  testBeforeAdd: false,
  toggleNoun: "Tracearr",
  icon: History,
  style: {
    text: "text-cyan-400",
    dot: "bg-cyan-400 shadow-[0_0_6px] shadow-cyan-400/60",
    tile: "bg-cyan-500/10",
    border: "border-cyan-500/30",
  },
  // deepcode ignore HardcodedNonCryptoSecret: Placeholder string
  placeholder: { name: "My Tracearr", url: "http://localhost:3000", apiKey: "API key from Tracearr settings" },
  addDescription: "Connection will be tested before saving.",
  emptyDescription: "Connect Tracearr to replace a server's coarse watch history with per-play events.",
  gridClassName: "sm:grid-cols-4",
  intro: (
    <>
      Tracearr records every play as its own event, so a linked media server&apos;s watch history carries
      per-play detail — completion percentage, device, player, transcode decision — that Plex, Jellyfin and
      Emby&apos;s own history does not report. Link a server under{" "}
      <span className="text-foreground">Media Servers → Watch history source</span>.
    </>
  ),
  // The consequence copy deliberately does NOT promise a fallback to native
  // history. With no enabled instance left, `syncWatchHistory` SKIPS a server
  // that is still linked to a Tracearr server rather than running the native
  // path — the native path full-replaces the server's rows, so falling back
  // would destroy the per-play history that was imported (and re-enabling
  // would then re-import it alongside the native rows, permanently doubling
  // `playCount`). The linked server therefore just stops updating until the
  // admin clears the link, which is the one thing this dialog has to say.
  //
  // No affected-server count: the link lives on `MediaServer.tracearrServerId`,
  // which this tab does not read. Naming the control the admin has to visit is
  // the actionable half anyway, and it reads correctly whatever the count.
  removeConsequence: (
    <>
      This removes the Tracearr connection from Librariarr. Any media server still linked to it stops updating
      its watch history — the sync skips a linked server instead of falling back, so the per-play history
      already imported is never overwritten by the server&apos;s own coarser history. To return a server to its
      native history, set its <span className="text-foreground">Watch history source</span> to &ldquo;Native
      (server history)&rdquo; under Media Servers. Nothing is changed in Tracearr itself.
    </>
  ),
};

// ─── Props ───

interface IntegrationsTabProps {
  /** Each type's instances, as the page last read them. */
  instances: Record<IntegrationType, IntegrationInstance[]>;
  /** Re-read one type's instance list. */
  onRefresh: (type: IntegrationType) => Promise<unknown>;
  /** A Tracearr instance was edited: its URL may now name another Tracearr. */
  onTracearrUpdated: (id: string) => unknown;
}

// ─── Component ───

/**
 * The instance lists come from the page (it loads them with the other tabs'
 * data, and the Media Servers tab reads Tracearr's); everything the forms hold
 * lives here, so typing in one re-renders this tab rather than the page — and,
 * memoised over props the page keeps stable, the page's own re-renders skip it.
 */
export const IntegrationsTab = memo(function IntegrationsTab({
  instances,
  onRefresh,
  onTracearrUpdated,
}: IntegrationsTabProps) {
  const sonarr = useIntegrationInstances(SONARR, { instances: instances.sonarr, refresh: () => onRefresh("sonarr") });
  const radarr = useIntegrationInstances(RADARR, { instances: instances.radarr, refresh: () => onRefresh("radarr") });
  const lidarr = useIntegrationInstances(LIDARR, { instances: instances.lidarr, refresh: () => onRefresh("lidarr") });
  const seerr = useIntegrationInstances(SEERR, { instances: instances.seerr, refresh: () => onRefresh("seerr") });
  const tracearr = useIntegrationInstances(TRACEARR, {
    instances: instances.tracearr,
    refresh: () => onRefresh("tracearr"),
    // The cached server list behind the watch-history dropdown is stale once
    // the instance's URL changes: it would keep offering servers that
    // instance no longer monitors.
    onUpdated: onTracearrUpdated,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect Sonarr, Radarr, Lidarr, and Overseerr/Jellyseerr for lifecycle rule matching and request
          data, and Tracearr for detailed playback history.
        </p>
      </div>

      <IntegrationInstanceSection config={SONARR} state={sonarr} />
      <IntegrationInstanceSection config={RADARR} state={radarr} />
      <IntegrationInstanceSection config={LIDARR} state={lidarr} />
      <IntegrationInstanceSection config={SEERR} state={seerr} />
      <IntegrationInstanceSection config={TRACEARR} state={tracearr} />
    </div>
  );
});
