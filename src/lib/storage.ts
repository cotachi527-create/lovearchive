"use client";

import {
  CollectionItem,
  DailyState,
  DEFAULT_PREFERENCES,
  GENRE_KEYS,
  normalizeImageUrls,
  Preferences,
  withSyncedImages,
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
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`localStorage への保存に失敗しました (${key})`, e);
  }
}

export function getCollection(): CollectionItem[] {
  const items = readJson<CollectionItem[]>(KEYS.collection, []);
  return items.map((item) => {
    const imageUrls = normalizeImageUrls(item);
    return withSyncedImages({
      ...item,
      genre: GENRE_KEYS.includes(item.genre) ? item.genre : "art",
      imageUrls,
      officialUrl: item.officialUrl ?? null,
      memo: item.memo ?? "",
      tags: Array.isArray(item.tags) ? item.tags : [],
    });
  });
}

export function saveCollection(items: CollectionItem[]) {
  writeJson(
    KEYS.collection,
    items.map((item) => withSyncedImages(item)),
  );
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
    imageSource?: string | null;
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

export function cacheKey(artist: string, title: string, genre?: string) {
  return `${(genre || "").trim()}::${artist.trim()}::${title.trim()}`.toLowerCase();
}
