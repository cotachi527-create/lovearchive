"use client";

import {
  CollectionItem,
  DailyState,
  DEFAULT_PREFERENCES,
  GENRE_KEYS,
  Preferences,
} from "./types";

const KEYS = {
  collection: "lovearchive.collection",
  preferences: "lovearchive.preferences",
  daily: "lovearchive.daily",
  enrichCache: "lovearchive.enrichCache",
} as const;

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

export function getCollection(): CollectionItem[] {
  return readJson<CollectionItem[]>(KEYS.collection, []);
}

export function saveCollection(items: CollectionItem[]) {
  writeJson(KEYS.collection, items);
}

export function getPreferences(): Preferences {
  const stored = readJson<Preferences | null>(KEYS.preferences, null);
  if (!stored) return structuredClone(DEFAULT_PREFERENCES);

  const genres = { ...DEFAULT_PREFERENCES.genres };
  const favoriteTags = { ...DEFAULT_PREFERENCES.favoriteTags };
  for (const g of GENRE_KEYS) {
    if (typeof stored.genres?.[g] === "boolean") {
      genres[g] = stored.genres[g];
    }
    favoriteTags[g] = Array.isArray(stored.favoriteTags?.[g])
      ? stored.favoriteTags[g]
      : [];
  }
  return { genres, favoriteTags };
}

export function savePreferences(prefs: Preferences) {
  writeJson(KEYS.preferences, prefs);
}

export function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getDailyState(): DailyState {
  const state = readJson<DailyState | null>(KEYS.daily, null);
  const today = todayKey();
  if (!state || state.date !== today) {
    return { date: today, mainPieceId: null, extraPieceIds: [] };
  }
  return state;
}

export function saveDailyState(state: DailyState) {
  writeJson(KEYS.daily, state);
}

export type EnrichCache = Record<
  string,
  {
    imageUrl: string | null;
    imageCredit: string | null;
    bio: string;
    latest: string;
    sourceUrls: { label: string; url: string }[];
    cachedAt: string;
  }
>;

export function getEnrichCache(): EnrichCache {
  return readJson<EnrichCache>(KEYS.enrichCache, {});
}

export function saveEnrichCache(cache: EnrichCache) {
  writeJson(KEYS.enrichCache, cache);
}

export function cacheKey(artist: string, title: string) {
  return `${artist.trim()}::${title.trim()}`.toLowerCase();
}
