"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSetState } from "@/hooks/use-set-state";

export const LIFECYCLE_EXCEPTIONS_URL = "/api/lifecycle/exceptions";
// The readers want the ids alone; the full listing carries every exception's
// item record and reason.
const EXCEPTED_IDS_URL = `${LIFECYCLE_EXCEPTIONS_URL}?idsOnly=1`;

/** Every excepted media item id, or null when the listing could not be read. */
export async function fetchExceptedItemIds(): Promise<Set<string> | null> {
  try {
    const response = await fetch(EXCEPTED_IDS_URL);
    if (!response.ok) return null;
    const data = (await response.json()) as { mediaItemIds?: string[] };
    return new Set(data.mediaItemIds ?? []);
  } catch {
    return null;
  }
}

export interface LifecycleExceptions {
  /** Items carrying an exception (loaded on mount, plus those excluded here). */
  exceptedIds: ReadonlySet<string>;
  /** Items whose exclusion is being saved. */
  excludingIds: ReadonlySet<string>;
  /**
   * File an exception for `mediaItemId`. True once saved (the id is then in
   * `exceptedIds`); a refusal is toasted with the route's reason.
   */
  exclude: (mediaItemId: string, options?: { reason?: string; label?: string }) => Promise<boolean>;
  refresh: () => Promise<void>;
}

/**
 * The lifecycle exceptions a page marks its items with and files from them —
 * Matches, Pending and the rule preview each kept the same set and the same
 * POST. `announce` toasts each saved exclusion, naming the `label` it was
 * given.
 */
export function useLifecycleExceptions(options: { announce?: boolean } = {}): LifecycleExceptions {
  const { announce = false } = options;
  const [exceptedIds, setExceptedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [excludingIds, { add: markExcluding, remove: unmarkExcluding }] = useSetState<string>();

  const refresh = useCallback(async () => {
    const ids = await fetchExceptedItemIds();
    if (ids) setExceptedIds(ids);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchExceptedItemIds().then((ids) => {
      if (ids && !cancelled) setExceptedIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const exclude = useCallback(
    async (mediaItemId: string, { reason, label }: { reason?: string; label?: string } = {}) => {
      markExcluding(mediaItemId);
      try {
        const response = await fetch(LIFECYCLE_EXCEPTIONS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaItemId, reason: reason || undefined }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          toast.error("Couldn't exclude item", { description: data.error });
          return false;
        }
        setExceptedIds((prev) => new Set(prev).add(mediaItemId));
        if (announce) toast.success("Excluded from lifecycle actions", { description: label });
        return true;
      } catch (error) {
        console.error("Failed to exclude item:", error);
        toast.error("Couldn't exclude item");
        return false;
      } finally {
        unmarkExcluding(mediaItemId);
      }
    },
    [announce, markExcluding, unmarkExcluding],
  );

  return { exceptedIds, excludingIds, exclude, refresh };
}
