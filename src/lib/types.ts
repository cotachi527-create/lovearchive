export type Genre = "art" | "game" | "movie" | "book" | "anime" | "music";

export const MAX_ITEM_IMAGES = 10;

export type CollectionItem = {
  id: string;
  artist: string;
  title: string;
  genre: Genre;
  /** 手動登録の画像URL・ファイル（最大10・表示優先） */
  imageUrls: string[];
  /** 後方互換: imageUrls[0] と同じ */
  imageUrl: string | null;
  /** 公式HP（スクリーンショット用） */
  officialUrl: string | null;
  memo: string;
  tags: string[];
  lastShownAt: string | null;
  createdAt: string;
};

export type PieceEnrichment = {
  imageUrl: string | null;
  imageCredit: string | null;
  /** 画像取得ソース（「他の画像」切替用） */
  imageSource: string | null;
  bio: string;
  latest: string;
  sourceUrls: { label: string; url: string }[];
};

export type FeedItem = {
  id: string;
  genre: Genre;
  title: string;
  summary: string;
  url: string | null;
};

export type Preferences = {
  genres: Record<Genre, boolean>;
  favoriteTags: Record<Genre, string[]>;
};

export type DailyState = {
  date: string;
  mainPieceId: string | null;
  extraPieceIds: string[];
};

export const GENRE_KEYS: Genre[] = [
  "art",
  "game",
  "movie",
  "book",
  "anime",
  "music",
];

export const GENRE_LABEL: Record<Genre, string> = {
  art: "Art",
  game: "Game",
  movie: "映画",
  book: "書籍",
  anime: "アニメ",
  music: "音楽（ライブ）",
};

export const DEFAULT_PREFERENCES: Preferences = {
  genres: {
    art: true,
    game: true,
    movie: true,
    book: true,
    anime: true,
    music: true,
  },
  favoriteTags: {
    art: [],
    game: [],
    movie: [],
    book: [],
    anime: [],
    music: [],
  },
};

/** 画像ファイルURL・data URLかどうか（公式HPと区別） */
export function isDirectImageUrl(url: string) {
  const u = url.trim();
  if (!u) return false;
  if (u.startsWith("data:image/")) return true;
  if (/\.(avif|bmp|gif|jpe?g|png|webp|svg)(\?|#|$)/i.test(u)) return true;
  if (/microlink\.io|thum\.io|images\.|img\.|cdn\.|covers\.|media\./i.test(u)) {
    return true;
  }
  // 拡張子なしでも画像を返すカバーAPI
  if (/coverartarchive\.org|books\.google\./i.test(u)) {
    return true;
  }
  return false;
}

/** 旧 imageUrl と imageUrls を統合して最大10件に正規化 */
export function normalizeImageUrls(
  item: Partial<CollectionItem> & { imageUrl?: string | null },
): string[] {
  const fromArray = Array.isArray(item.imageUrls) ? item.imageUrls : [];
  const fromSingle = item.imageUrl ? [item.imageUrl] : [];
  const merged = [...fromArray, ...fromSingle].filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of merged) {
    const u = raw.trim();
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= MAX_ITEM_IMAGES) break;
  }
  return out;
}

export function withSyncedImages(
  item: Omit<CollectionItem, "imageUrl" | "imageUrls" | "officialUrl"> & {
    imageUrls?: string[];
    imageUrl?: string | null;
    officialUrl?: string | null;
  },
): CollectionItem {
  const rawUrls = normalizeImageUrls(item);
  const officialFromField = (item.officialUrl || "").trim() || null;

  // 旧データ: 画像っぽくないURLは公式HPへ移す
  const imageUrls: string[] = [];
  let migratedOfficial: string | null = officialFromField;
  for (const u of rawUrls) {
    if (isDirectImageUrl(u) || u.startsWith("data:") || u.startsWith("idb:")) {
      if (imageUrls.length < MAX_ITEM_IMAGES) imageUrls.push(u);
    } else if (!migratedOfficial && /^https?:\/\//i.test(u)) {
      migratedOfficial = u;
    } else if (imageUrls.length < MAX_ITEM_IMAGES) {
      // 判定できないURLは画像側に残す
      imageUrls.push(u);
    }
  }

  return {
    ...item,
    imageUrls,
    imageUrl: imageUrls[0] || null,
    officialUrl: migratedOfficial,
  };
}
