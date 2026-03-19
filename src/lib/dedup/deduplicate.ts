/**
 * Cross-server media deduplication.
 *
 * Pure functions — no database calls. Operates on arrays of items
 * that have already been fetched from the database.
 */

export interface ServerPresence {
  serverId: string;
  serverName: string;
  serverType: string;
  mediaItemId: string;
}

// Minimal shape required from an item for deduplication
export interface DeduplicableItem {
  id: string;
  title: string;
  year?: number | null;
  type: string;
  parentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  externalIds?: { source: string; externalId: string }[];
  library: {
    mediaServer: {
      id: string;
      name: string;
      type: string;
    };
  };
}

import { normalizeTitle } from "./compute-dedup-key";
export { normalizeTitle } from "./compute-dedup-key";

function getExternalId(
  item: DeduplicableItem,
  source: string
): string | undefined {
  return item.externalIds?.find(
    (e) => e.source.toLowerCase() === source.toLowerCase()
  )?.externalId;
}

/**
 * Compute all dedup keys for an item. Items sharing ANY key are considered
 * duplicates across servers. Multiple keys handle cases where one server
 * has a TMDB ID and another only has an IMDB ID for the same movie.
 */
function getDeduplicationKeys(item: DeduplicableItem): string[] {
  if (item.type === "MOVIE") {
    const keys: string[] = [];
    const tmdb = getExternalId(item, "tmdb");
    if (tmdb) keys.push(`tmdb:${tmdb}`);
    const imdb = getExternalId(item, "imdb");
    if (imdb) keys.push(`imdb:${imdb}`);
    // Title+year as fallback only when no external IDs
    if (keys.length === 0) {
      keys.push(`title:${normalizeTitle(item.title)}:${item.year ?? ""}`);
    }
    return keys;
  }

  if (item.type === "SERIES") {
    const parent = item.parentTitle
      ? normalizeTitle(item.parentTitle)
      : normalizeTitle(item.title);
    return [`series:${parent}:s${item.seasonNumber ?? 0}e${item.episodeNumber ?? 0}`];
  }

  if (item.type === "MUSIC") {
    const parent = item.parentTitle
      ? normalizeTitle(item.parentTitle)
      : "unknown";
    return [`music:${parent}:${normalizeTitle(item.title)}`];
  }

  return [`title:${normalizeTitle(item.title)}:${item.year ?? ""}`];
}

export interface DeduplicatedResult<T> {
  items: (T & { servers: ServerPresence[]; matchedBy: string | null })[];
  total: number;
}

// Artwork fields that can be overridden from the preferred artwork server
const ARTWORK_FIELDS = ["thumbUrl", "parentThumbUrl", "seasonThumbUrl", "artUrl"] as const;

/**
 * Deduplicates a flat list of items (movies, episodes, or tracks).
 *
 * For each group of duplicates, the item from `preferredTitleServerId` is chosen
 * as primary (for title). If `preferredArtworkServerId` differs, artwork fields
 * are overlaid from that server's item.
 *
 * Returns items augmented with a `servers` array listing every server
 * that has a copy.
 */
export function deduplicateItems<T extends DeduplicableItem>(
  items: T[],
  preferredTitleServerId: string | null,
  preferredArtworkServerId?: string | null
): DeduplicatedResult<T> {
  type Group = { primary: T; artworkSource: T | null; servers: ServerPresence[]; matchedBy: string | null };

  // Map from any dedup key → group. Multiple keys can point to the same group,
  // enabling matches when servers have different external IDs for the same item.
  const keyToGroup = new Map<string, Group>();
  const allGroups = new Set<Group>();

  for (const item of items) {
    const keys = getDeduplicationKeys(item);
    const server = item.library.mediaServer;
    const presence: ServerPresence = {
      serverId: server.id,
      serverName: server.name,
      serverType: server.type,
      mediaItemId: item.id,
    };

    // Find existing group via any matching key
    let existing: Group | undefined;
    let matchKey: string | undefined;
    for (const key of keys) {
      existing = keyToGroup.get(key);
      if (existing) {
        matchKey = key;
        break;
      }
    }

    if (!existing) {
      const group: Group = { primary: item, artworkSource: null, servers: [presence], matchedBy: null };
      for (const key of keys) keyToGroup.set(key, group);
      allGroups.add(group);
    } else {
      // Record what type of key matched (only on first cross-server match)
      if (matchKey && !existing.matchedBy && existing.servers.length > 0 && !existing.servers.some((s) => s.serverId === server.id)) {
        const prefix = matchKey.split(":")[0];
        const MATCH_LABELS: Record<string, string> = {
          tmdb: "TMDB ID",
          imdb: "IMDB ID",
          title: "Title + Year",
          series: "Series + Episode",
          music: "Artist + Track",
        };
        existing.matchedBy = MATCH_LABELS[prefix] ?? prefix.toUpperCase();
      }
      // Register all keys for this item to point to the same group
      for (const key of keys) keyToGroup.set(key, existing);
      // Avoid adding the same server twice
      if (!existing.servers.some((s) => s.serverId === server.id)) {
        existing.servers.push(presence);
      }
      // Swap primary if this item is from the preferred title server
      if (
        preferredTitleServerId &&
        server.id === preferredTitleServerId &&
        existing.primary.library.mediaServer.id !== preferredTitleServerId
      ) {
        existing.primary = item;
      }
      // Track artwork source separately
      if (
        preferredArtworkServerId &&
        server.id === preferredArtworkServerId
      ) {
        existing.artworkSource = item;
      }
    }
  }

  const deduped = Array.from(allGroups).map(({ primary, artworkSource, servers, matchedBy }) => {
    const result = {
      ...primary,
      servers: servers.sort((a, b) => a.serverName.localeCompare(b.serverName)),
      matchedBy,
    };
    // Overlay artwork from preferred artwork server if different from primary
    if (
      artworkSource &&
      artworkSource.library.mediaServer.id !== primary.library.mediaServer.id
    ) {
      for (const field of ARTWORK_FIELDS) {
        const val = (artworkSource as unknown as Record<string, unknown>)[field];
        if (val != null) {
          (result as unknown as Record<string, unknown>)[field] = val;
        }
      }
    }
    return result;
  });

  return { items: deduped, total: deduped.length };
}

/**
 * Builds a single ServerPresence entry for a single-server filtered view.
 */
export function buildSingleServerPresence(
  serverId: string,
  serverName: string,
  serverType: string,
  mediaItemId: string
): ServerPresence[] {
  return [{ serverId, serverName, serverType, mediaItemId }];
}

// ---- Helpers for grouped routes (series/music) ----

export interface GroupedDeduplicationContext {
  /** Track unique episode/track keys to avoid double-counting */
  seenKeys: Set<string>;
  /** Servers contributing to this group */
  servers: Map<string, ServerPresence>;
  /** The preferred server's variant of the group title */
  preferredTitle: string | null;
  /** The preferred server's thumbnail */
  preferredThumbUrl: string | null;
  /** The preferred server's mediaItemId (for thumbnail) */
  preferredMediaItemId: string | null;
}

export function createGroupedContext(): GroupedDeduplicationContext {
  return {
    seenKeys: new Set(),
    servers: new Map(),
    preferredTitle: null,
    preferredThumbUrl: null,
    preferredMediaItemId: null,
  };
}

/**
 * Processes a single item within a grouped aggregation, returning whether
 * this item is a duplicate (already counted for a different server).
 *
 * Call this for each raw item. If it returns `true`, the item is a new
 * unique entry and should be counted. If `false`, it's a cross-server
 * duplicate and should be skipped for counting purposes.
 */
export function processGroupedItem(
  ctx: GroupedDeduplicationContext,
  item: {
    id: string;
    parentTitle?: string | null;
    title?: string;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    thumbUrl?: string | null;
    parentThumbUrl?: string | null;
    type?: string;
    library?: {
      mediaServer: { id: string; name: string; type: string };
    };
  },
  serverId: string,
  serverName: string,
  serverType: string,
  preferredServerId: string | null
): boolean {
  // Track server
  if (!ctx.servers.has(serverId)) {
    ctx.servers.set(serverId, {
      serverId,
      serverName,
      serverType,
      mediaItemId: item.id,
    });
  }

  // Track preferred title/thumb
  if (preferredServerId && serverId === preferredServerId) {
    if (item.parentTitle) ctx.preferredTitle = item.parentTitle;
    const thumb = item.parentThumbUrl ?? item.thumbUrl;
    if (thumb) {
      ctx.preferredThumbUrl = thumb;
      ctx.preferredMediaItemId = item.id;
    }
  }

  // Build unique key for this specific episode/track
  let uniqueKey: string;
  if (item.seasonNumber != null || item.episodeNumber != null) {
    // Series episode
    uniqueKey = `s${item.seasonNumber ?? 0}e${item.episodeNumber ?? 0}`;
  } else if (item.title) {
    // Music track
    uniqueKey = normalizeTitle(item.title);
  } else {
    // Fallback: use item id (no dedup)
    uniqueKey = item.id;
  }

  if (ctx.seenKeys.has(uniqueKey)) {
    return false; // duplicate — skip for counting
  }
  ctx.seenKeys.add(uniqueKey);
  return true; // new unique item — count it
}

/**
 * Extract the final servers array from a grouped context.
 */
export function getGroupServers(
  ctx: GroupedDeduplicationContext
): ServerPresence[] {
  return Array.from(ctx.servers.values()).sort((a, b) =>
    a.serverName.localeCompare(b.serverName)
  );
}
