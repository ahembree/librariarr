"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { useIntegrationsHealth, type IntegrationsHealth } from "@/hooks/use-integrations-health";
import { fetchExceptedItemIds } from "@/hooks/use-lifecycle-exceptions";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

/**
 * What the lifecycle rule editor reads that does not depend on its tab: the
 * rule sets (every type), the media servers, the integration instances, the
 * library's distinct values, the excepted items and the integrations' health.
 *
 * Each `LifecycleRulePage` tab loaded all of these itself on mount — about
 * nine requests, seven of them identical for every tab — so a Movies → Series
 * → Music walk asked for the same rule sets, servers and distinct values (a
 * scan of every item and stream) three times. The rules page loads them once
 * and hands them to whichever tab is open.
 */

export interface CollectionDefinition {
  id: string;
  name: string;
  sortName: string | null;
  homeScreen: boolean;
  recommended: boolean;
  sort: string;
  _count?: { ruleSets: number };
}

export interface SavedRuleSet {
  id: string;
  name: string;
  type: string;
  rules: LifecycleRule[] | LifecycleRuleGroup[];
  enabled: boolean;
  seriesScope?: boolean;
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  arrInstanceId: string | null;
  targetQualityProfileId?: number | null;
  addImportExclusion: boolean;
  searchAfterAction?: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  collectionId: string | null;
  collection?: CollectionDefinition | null;
  discordNotifyOnAction: boolean;
  discordNotifyOnMatch?: boolean;
  stickyMatches?: boolean;
  serverIds: string[];
  createdAt: string;
}

export interface ArrInstance {
  id: string;
  name: string;
  url: string;
}

/**
 * Why a server's play history cannot answer play-activity criteria, or null
 * when it can — mirroring `checkWatchHistoryCompleteness`, so the editor can
 * WARN before a refusal; the server-side guard stays the authority.
 *
 * The two faults are kept apart because their REMEDIES are opposites.
 * `"importing"` (`tracearrBackfillComplete` false) is resolved by waiting —
 * the newest-first archive walk is still running. `"unsynced"`
 * (`watchHistorySyncedAt` null) is not resolved by waiting at all: the marker
 * was never set, or was withdrawn by a source change, a purge, a restore, or
 * a sync that could not load Tracearr's account map — and on a server whose
 * Tracearr import has long since finished, "watch the import progress" points
 * the user at a bar that already reads done.
 */
export type PlayHistoryFault = "unsynced" | "importing" | null;

export interface RuleEditorServer {
  id: string;
  name: string;
  type: string;
  /** Disabled servers are outside every guard's scope — `checkWatchHistoryCompleteness`
   *  counts `enabled: true` only, and `runDetection` intersects the rule set's
   *  targets with the enabled set before evaluating. */
  enabled: boolean;
  playHistoryFault: PlayHistoryFault;
}

interface ServerRow {
  id: string;
  name: string;
  type: string;
  enabled?: boolean;
  watchHistorySyncedAt?: string | null;
  tracearrServerId?: string | null;
  tracearrBackfillComplete?: boolean;
}

/**
 * A field absent from the payload reads as ESTABLISHED. This only decides
 * whether to show a warning, and a false alarm about play history is worse
 * than no banner: the server-side guard still refuses and reports its reason,
 * so guessing wrong here costs a missing hint, not a missed refusal.
 *
 * `unsynced` is tested first, matching the server-side guard: a server can be
 * both, and the marker being absent is the fault that waiting will not fix.
 */
export function playHistoryFaultOf(s: ServerRow): PlayHistoryFault {
  if (s.watchHistorySyncedAt === undefined) return null;
  if (s.watchHistorySyncedAt === null) return "unsynced";
  if (s.tracearrServerId != null && s.tracearrBackfillComplete === false) return "importing";
  return null;
}

export function toRuleEditorServer(s: ServerRow): RuleEditorServer {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: s.enabled !== false,
    playHistoryFault: playHistoryFaultOf(s),
  };
}

export interface RuleEditorIntegrations {
  radarr: ArrInstance[];
  sonarr: ArrInstance[];
  lidarr: ArrInstance[];
  /**
   * An ENABLED Seerr instance exists. Lifecycle evaluation reads every enabled
   * instance (`fetchSeerrMetadata`), so a disabled one is not "connected".
   */
  seerrConnected: boolean;
  /**
   * The "Requested By" choices, the union across enabled instances; null
   * while unread (and with no enabled instance, when it is never read).
   */
  seerrUsers: string[] | null;
}

interface InstancesBody {
  radarr?: ArrInstance[];
  sonarr?: ArrInstance[];
  lidarr?: ArrInstance[];
  seerr?: Array<{ id: string; enabled?: boolean }>;
  seerrUsers?: string[];
}

export function integrationsFrom(body: InstancesBody): RuleEditorIntegrations {
  return {
    radarr: body.radarr ?? [],
    sonarr: body.sonarr ?? [],
    lidarr: body.lidarr ?? [],
    seerrConnected: (body.seerr ?? []).some((i) => i.enabled !== false),
    seerrUsers: null,
  };
}

/**
 * "Matched By Rule Set" offers every rule set's name. The distinct-values
 * route reads them at the time it answered; built from the rule sets held
 * here it follows a save or a delete on this page without re-reading that
 * route (a scan of every item and stream).
 */
export function ruleSetNameValues(ruleSets: readonly { name: string }[]): string[] {
  return [...new Set(ruleSets.map((r) => r.name))].sort((a, b) => a.localeCompare(b));
}

export interface RuleEditorData {
  /** Every rule set, of every type; null until the first read answers. */
  ruleSets: SavedRuleSet[] | null;
  refreshRuleSets: () => Promise<void>;
  servers: RuleEditorServer[];
  /** Null until the instances are read. */
  integrations: RuleEditorIntegrations | null;
  /** The library's distinct values (the filter bar's), `matchedByRuleSet` from `ruleSets`. */
  distinctValues: Record<string, string[]>;
  /** Items carrying a lifecycle exception, for the preview's indicator. */
  exceptedItemIds: Set<string>;
  integrationsHealth: IntegrationsHealth;
}

async function readJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

// A Tracearr backfill finishing is what CLEARS the editor's play-history
// warning, minutes to hours after the page mounted; without a refresh the
// banner would keep claiming a rule set is paused long after the import
// finished. Both events carry only `meta.serverId`, so the list is re-read.
const SERVER_EVENTS = ["tracearr:import-progress", "watch-history:updated"] as const;

export function useRuleEditorData(): RuleEditorData {
  const [ruleSets, setRuleSets] = useState<SavedRuleSet[] | null>(null);
  const [servers, setServers] = useState<RuleEditorServer[]>([]);
  const [integrations, setIntegrations] = useState<RuleEditorIntegrations | null>(null);
  const [libraryValues, setLibraryValues] = useState<Record<string, string[]>>({});
  const [exceptedItemIds, setExceptedItemIds] = useState<Set<string>>(() => new Set());
  const { health: integrationsHealth } = useIntegrationsHealth();

  const refreshRuleSets = useCallback(async () => {
    const data = await readJson<{ ruleSets?: SavedRuleSet[] }>("/api/lifecycle/rules");
    if (data?.ruleSets) setRuleSets(data.ruleSets);
    else if (!data) console.error("Failed to fetch rule sets");
  }, []);

  const refreshServers = useCallback(async () => {
    const data = await readJson<{ servers?: ServerRow[] }>("/api/servers");
    if (data) setServers((data.servers ?? []).map(toRuleEditorServer));
    else console.error("Failed to fetch servers");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([refreshRuleSets(), refreshServers()]);
    })();
    void readJson<Record<string, string[]>>("/api/media/distinct-values").then((data) => {
      if (data && !cancelled) setLibraryValues(data);
      else if (!data) console.error("Failed to fetch distinct values");
    });
    void fetchExceptedItemIds().then((ids) => {
      if (ids && !cancelled) setExceptedItemIds(ids);
    });
    // The instance lists answer at once; the Seerr requester names need each
    // enabled instance asked, so they are read only when there is one, and
    // never hold up the Arr pickers.
    void readJson<InstancesBody>("/api/integrations/instances").then(async (body) => {
      if (!body || cancelled) return;
      const lists = integrationsFrom(body);
      setIntegrations(lists);
      if (!lists.seerrConnected) return;
      const withUsers = await readJson<InstancesBody>("/api/integrations/instances?withMetadata=1");
      if (cancelled) return;
      const users = withUsers?.seerrUsers ?? [];
      setIntegrations((prev) => (prev ? { ...prev, seerrUsers: users } : prev));
    });
    return () => {
      cancelled = true;
    };
  }, [refreshRuleSets, refreshServers]);

  useRealtimeEvents(SERVER_EVENTS, () => {
    void refreshServers();
  });

  const distinctValues = useMemo(
    () => (ruleSets ? { ...libraryValues, matchedByRuleSet: ruleSetNameValues(ruleSets) } : libraryValues),
    [libraryValues, ruleSets],
  );

  return {
    ruleSets,
    refreshRuleSets,
    servers,
    integrations,
    distinctValues,
    exceptedItemIds,
    integrationsHealth,
  };
}
