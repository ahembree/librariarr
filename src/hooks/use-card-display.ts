"use client";

import { useState, useCallback, useEffect, useRef } from "react";

export type CardLibraryType =
  | "MOVIE"
  | "SERIES"
  | "SERIES_SEASONS"
  | "SERIES_EPISODES"
  | "MUSIC"
  | "MUSIC_ALBUMS"
  | "MUSIC_TRACKS";

export interface CardDisplayPreferences {
  badges: Record<string, boolean>;
  metadata: Record<string, boolean>;
  servers: boolean;
}

export type AllCardDisplayPreferences = Partial<
  Record<CardLibraryType, CardDisplayPreferences>
>;

export interface ToggleConfig {
  badges: { key: string; label: string }[];
  metadata: { key: string; label: string }[];
}

const STORAGE_KEY = "card-display-preferences";

const DEFAULTS: Record<CardLibraryType, CardDisplayPreferences> = {
  MOVIE: {
    badges: { resolution: true, dynamicRange: true },
    metadata: { year: true, duration: true, fileSize: true },
    servers: true,
  },
  SERIES: {
    badges: { qualityCounts: true },
    metadata: { seasonCount: true, episodeCount: true, fileSize: true },
    servers: true,
  },
  SERIES_SEASONS: {
    badges: { qualityCounts: true },
    metadata: { episodeCount: true, fileSize: true, playCount: true },
    servers: true,
  },
  SERIES_EPISODES: {
    badges: { resolution: true, dynamicRange: true, audioProfile: true },
    metadata: { seriesName: true, episodeLabel: true, duration: true, fileSize: true },
    servers: true,
  },
  MUSIC: {
    badges: { audioCodecs: true },
    metadata: { albumCount: true, trackCount: true, fileSize: true },
    servers: true,
  },
  MUSIC_ALBUMS: {
    badges: { audioCodecs: true },
    metadata: { trackCount: true, fileSize: true },
    servers: true,
  },
  MUSIC_TRACKS: {
    badges: { audioCodec: true },
    metadata: { trackNumber: true, duration: true, fileSize: true },
    servers: true,
  },
};

export const TOGGLE_CONFIGS: Record<CardLibraryType, ToggleConfig> = {
  MOVIE: {
    badges: [
      { key: "resolution", label: "Resolution" },
      { key: "dynamicRange", label: "Dynamic Range" },
    ],
    metadata: [
      { key: "year", label: "Year" },
      { key: "duration", label: "Duration" },
      { key: "fileSize", label: "File Size" },
    ],
  },
  SERIES: {
    badges: [{ key: "qualityCounts", label: "Quality Counts" }],
    metadata: [
      { key: "seasonCount", label: "Season Count" },
      { key: "episodeCount", label: "Episode Count" },
      { key: "fileSize", label: "File Size" },
    ],
  },
  SERIES_SEASONS: {
    badges: [{ key: "qualityCounts", label: "Quality Counts" }],
    metadata: [
      { key: "episodeCount", label: "Episode Count" },
      { key: "fileSize", label: "File Size" },
      { key: "playCount", label: "Play Count" },
    ],
  },
  SERIES_EPISODES: {
    badges: [
      { key: "resolution", label: "Resolution" },
      { key: "dynamicRange", label: "Dynamic Range" },
      { key: "audioProfile", label: "Audio Profile" },
    ],
    metadata: [
      { key: "seriesName", label: "Series Name" },
      { key: "episodeLabel", label: "Episode Label" },
      { key: "duration", label: "Duration" },
      { key: "fileSize", label: "File Size" },
    ],
  },
  MUSIC: {
    badges: [{ key: "audioCodecs", label: "Audio Codecs" }],
    metadata: [
      { key: "albumCount", label: "Album Count" },
      { key: "trackCount", label: "Track Count" },
      { key: "fileSize", label: "File Size" },
    ],
  },
  MUSIC_ALBUMS: {
    badges: [{ key: "audioCodecs", label: "Audio Codecs" }],
    metadata: [
      { key: "trackCount", label: "Track Count" },
      { key: "fileSize", label: "File Size" },
    ],
  },
  MUSIC_TRACKS: {
    badges: [{ key: "audioCodec", label: "Audio Codec" }],
    metadata: [
      { key: "trackNumber", label: "Track Number" },
      { key: "duration", label: "Duration" },
      { key: "fileSize", label: "File Size" },
    ],
  },
};

function loadFromStorage(): AllCardDisplayPreferences {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function getPrefs(
  all: AllCardDisplayPreferences,
  type: CardLibraryType,
): CardDisplayPreferences {
  const stored = all[type];
  const defaults = DEFAULTS[type];
  if (!stored) return defaults;
  return {
    badges: { ...defaults.badges, ...stored.badges },
    metadata: { ...defaults.metadata, ...stored.metadata },
    servers: stored.servers ?? defaults.servers,
  };
}

export function useCardDisplay(libraryType: CardLibraryType) {
  const [allPrefs, setAllPrefs] = useState<AllCardDisplayPreferences>(loadFromStorage);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);

  // Hydrate from API once (background)
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    fetch("/api/settings/card-display-preferences")
      .then((r) => r.json())
      .then((data) => {
        if (data.preferences) {
          setAllPrefs((prev) => {
            // Only fill in keys not already in localStorage
            const localKeys = Object.keys(prev);
            if (localKeys.length > 0) return prev;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data.preferences));
            return data.preferences as AllCardDisplayPreferences;
          });
        }
      })
      .catch(() => {});
  }, []);

  const prefs = getPrefs(allPrefs, libraryType);

  const show = useCallback(
    (section: "badges" | "metadata", key: string): boolean => {
      return prefs[section][key] ?? true;
    },
    [prefs],
  );

  const showServers = prefs.servers;

  const setVisible = useCallback(
    (section: "badges" | "metadata" | "servers", key: string, visible: boolean) => {
      setAllPrefs((prev) => {
        const current = getPrefs(prev, libraryType);
        let updated: CardDisplayPreferences;
        if (section === "servers") {
          updated = { ...current, servers: visible };
        } else {
          updated = {
            ...current,
            [section]: { ...current[section], [key]: visible },
          };
        }
        const next = { ...prev, [libraryType]: updated };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

        // Debounced API sync
        if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = setTimeout(() => {
          fetch("/api/settings/card-display-preferences", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preferences: next }),
          }).catch(() => {});
        }, 1000);

        return next;
      });
    },
    [libraryType],
  );

  return { show, showServers, setVisible, prefs };
}
