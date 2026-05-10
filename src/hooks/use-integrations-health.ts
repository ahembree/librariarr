"use client";

import { useEffect, useState } from "react";

export interface InstanceHealth {
  id: string;
  name: string;
  reachable: boolean;
  error: string | null;
}

export interface IntegrationTypeHealth {
  configured: number;
  reachable: number;
  instances: InstanceHealth[];
}

export interface IntegrationsHealth {
  sonarr: IntegrationTypeHealth;
  radarr: IntegrationTypeHealth;
  lidarr: IntegrationTypeHealth;
  seerr: IntegrationTypeHealth;
  arrAnyReachable: boolean;
}

const EMPTY_TYPE: IntegrationTypeHealth = { configured: 0, reachable: 0, instances: [] };
const EMPTY: IntegrationsHealth = {
  sonarr: EMPTY_TYPE,
  radarr: EMPTY_TYPE,
  lidarr: EMPTY_TYPE,
  seerr: EMPTY_TYPE,
  arrAnyReachable: false,
};

/**
 * Fetches the user's integration reachability snapshot from the server.
 * Server-side cached for 30s, so repeated mounts on different pages share
 * the same response without thrashing.
 */
export function useIntegrationsHealth() {
  const [health, setHealth] = useState<IntegrationsHealth>(EMPTY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations/health?fresh=1")
      .then((res) => (res.ok ? (res.json() as Promise<IntegrationsHealth>) : null))
      .then((data) => {
        if (cancelled) return;
        if (data) setHealth(data);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { health, loading };
}

export type ArrType = "sonarr" | "radarr" | "lidarr";
export type LibraryMediaType = "MOVIE" | "SERIES" | "MUSIC";

/**
 * Map a media type to the *arr type that handles it. SERIES → Sonarr,
 * MOVIE → Radarr, MUSIC → Lidarr. Returns undefined for unknown types.
 */
export function arrTypeForMediaType(mediaType: LibraryMediaType): ArrType {
  return mediaType === "MOVIE" ? "radarr" : mediaType === "MUSIC" ? "lidarr" : "sonarr";
}

export interface DeriveStatusOptions {
  /**
   * If provided, only Arr instances with these IDs are considered. Otherwise
   * all instances of the given `relevantArrTypes` (or all types if omitted)
   * are considered. Pass the rule set's selected `arrInstanceId` here so the
   * indicator only fires for the integration this rule actually depends on.
   */
  arrInstanceIds?: readonly string[];
  /**
   * If provided, only Seerr instances with these IDs are considered.
   */
  seerrInstanceIds?: readonly string[];
  /**
   * Fallback type filter when `arrInstanceIds` is not supplied. SERIES rule
   * sets pass `["sonarr"]`; MOVIE pass `["radarr"]`; MUSIC pass `["lidarr"]`.
   * Default: all three.
   */
  relevantArrTypes?: readonly ArrType[];
}

/**
 * Derive per-instance / per-type unreachability for the surface in question.
 *
 * Selection precedence:
 *   1. If `arrInstanceIds` is non-undefined: filter to only those instances.
 *      Empty array → no Arr instances considered → arrUnreachable = false.
 *   2. Else if `relevantArrTypes` is provided: consider all instances of
 *      those types.
 *   3. Else: consider every Arr instance.
 *
 * Same precedence for Seerr via `seerrInstanceIds`.
 */
export function deriveIntegrationsStatus(
  health: IntegrationsHealth,
  options: DeriveStatusOptions | readonly ArrType[] = {},
) {
  // Backward-compat: callers passing a bare ArrType[] are treated as
  // `{ relevantArrTypes: ... }`.
  const opts: DeriveStatusOptions = Array.isArray(options)
    ? { relevantArrTypes: options as readonly ArrType[] }
    : (options as DeriveStatusOptions);

  const relevantArrTypes = opts.relevantArrTypes ?? (["sonarr", "radarr", "lidarr"] as const);

  const allArrInstances = relevantArrTypes.flatMap((t) => health[t].instances);
  const arrInstances = opts.arrInstanceIds !== undefined
    ? allArrInstances.filter((i) => opts.arrInstanceIds!.includes(i.id))
    : allArrInstances;

  const arrUnreachableInstances = arrInstances.filter((i) => !i.reachable);
  const arrConfigured = arrInstances.length > 0;
  const arrUnreachable = arrConfigured && arrUnreachableInstances.length > 0;

  const allSeerrInstances = health.seerr.instances;
  const seerrInstances = opts.seerrInstanceIds !== undefined
    ? allSeerrInstances.filter((i) => opts.seerrInstanceIds!.includes(i.id))
    : allSeerrInstances;

  const seerrUnreachableInstances = seerrInstances.filter((i) => !i.reachable);
  const seerrConfigured = seerrInstances.length > 0;
  const seerrUnreachable = seerrConfigured && seerrUnreachableInstances.length > 0;

  return {
    arrConfigured,
    arrUnreachable,
    seerrConfigured,
    seerrUnreachable,
    unreachableArrNames: arrUnreachableInstances.map((i) => i.name),
    unreachableSeerrNames: seerrUnreachableInstances.map((i) => i.name),
  };
}
