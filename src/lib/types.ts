export type Genre = "art" | "game" | "movie" | "book" | "anime" | "music";

export type CollectionItem = {
  id: string;
  artist: string;
  title: string;
  memo: string;
  tags: string[];
  lastShownAt: string | null;
  createdAt: string;
};

export type PieceEnrichment = {
  imageUrl: string | null;
  imageCredit: string | null;
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
