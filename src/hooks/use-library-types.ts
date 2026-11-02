"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { createRealtimeResource } from "@/hooks/use-realtime-resource";
import { useShellSnapshot } from "@/components/shell-settings-provider";
import type { LibraryTypes } from "@/lib/media/library-types";

export const LIBRARY_TYPES_URL = "/api/media/library-types";

function parseLibraryTypes(body: unknown): LibraryTypes | null {
  const { types, allTypes } = body as Partial<LibraryTypes>;
  if (!Array.isArray(types) && !Array.isArray(allTypes)) return null;
  return { types: Array.isArray(types) ? types : [], allTypes: Array.isArray(allTypes) ? allTypes : [] };
}

/**
 * Which library types exist (`GET /api/media/library-types`), held for the
 * tab. A server added, removed or turned off, a library enabled, or a first
 * sync finishing all change it, and each emits `server:changed` or
 * `sync:completed`.
 */
export const libraryTypesResource = createRealtimeResource<LibraryTypes>({
  url: LIBRARY_TYPES_URL,
  events: ["server:changed", "sync:completed"],
  parse: parseLibraryTypes,
});

const noValue = () => null;

/**
 * The library types, for the sidebar's Library links and any page that builds
 * on them, without a request of its own.
 *
 * The authenticated layout reads them with the page (`shell.libraryTypes`),
 * which the sidebar — mounted with the shell on that very render — seeds the
 * store with, so the first paint is right with no request. The layout does not
 * render again on a client-side navigation, so the shell's copy goes stale;
 * from then on only the store, kept current by the events above (and re-read
 * by a reader that mounts while the stream is down), is read. Null until
 * either answers (outside the shell, before the first read).
 */
export function useLibraryTypes(): LibraryTypes | null {
  const shell = useShellSnapshot();
  const seed = shell?.libraryTypes ?? null;
  const stored = useSyncExternalStore(libraryTypesResource.subscribe, libraryTypesResource.getSnapshot, noValue);

  useEffect(() => {
    if (seed) libraryTypesResource.seed(seed);
    if (libraryTypesResource.needsRefresh()) void libraryTypesResource.refresh();
    // The seed is taken once: a later copy of the shell's is no newer than the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime("server:changed", libraryTypesResource.refresh);
  useRealtime("sync:completed", libraryTypesResource.refresh);

  // Until the store holds anything (this render hydrates the layout's HTML),
  // the layout's read is the answer.
  return stored ?? seed;
}
