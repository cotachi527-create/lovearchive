"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { pickPiece } from "@/lib/pickPiece";
import {
  cacheKey,
  getCollection,
  getDailyState,
  getEnrichCache,
  getPreferences,
  saveCollection,
  saveDailyState,
  saveEnrichCache,
  savePreferences,
  todayKey,
} from "@/lib/storage";
import {
  CollectionItem,
  FeedItem,
  GENRE_KEYS,
  GENRE_LABEL,
  Genre,
  PieceEnrichment,
  Preferences,
} from "@/lib/types";

const GENRE_STYLE: Record<Genre, string> = {
  art: "bg-amber-500/20 text-amber-300",
  game: "bg-emerald-500/20 text-emerald-300",
  movie: "bg-sky-500/20 text-sky-300",
  book: "bg-orange-500/20 text-orange-300",
  anime: "bg-pink-500/20 text-pink-300",
  music: "bg-fuchsia-500/20 text-fuchsia-300",
};

type Panel = "home" | "collection" | "settings";

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function LoveArchiveApp() {
  const [panel, setPanel] = useState<Panel>("home");
  const [collection, setCollection] = useState<CollectionItem[]>([]);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [ready, setReady] = useState(false);

  const [current, setCurrent] = useState<CollectionItem | null>(null);
  const [enrichment, setEnrichment] = useState<PieceEnrichment | null>(null);
  const [loadingPiece, setLoadingPiece] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasDrawnToday, setHasDrawnToday] = useState(false);

  // forms
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [memoDraft, setMemoDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [favDraft, setFavDraft] = useState<Record<Genre, string>>({
    art: "",
    game: "",
    movie: "",
    book: "",
    anime: "",
    music: "",
  });

  useEffect(() => {
    setCollection(getCollection());
    setPrefs(getPreferences());
    const daily = getDailyState();
    setHasDrawnToday(Boolean(daily.mainPieceId));
    if (daily.mainPieceId) {
      const item = getCollection().find((c) => c.id === daily.mainPieceId);
      if (item) {
        setCurrent(item);
        setMemoDraft(item.memo);
        const cache = getEnrichCache()[cacheKey(item.artist, item.title)];
        if (cache) {
          setEnrichment({
            imageUrl: cache.imageUrl,
            imageCredit: cache.imageCredit,
            bio: cache.bio,
            latest: cache.latest,
            sourceUrls: cache.sourceUrls,
          });
        }
      }
    }
    setReady(true);
  }, []);

  const activeGenres = useMemo(() => {
    if (!prefs) return [] as Genre[];
    return (Object.keys(prefs.genres) as Genre[]).filter((g) => prefs.genres[g]);
  }, [prefs]);

  const loadFeed = useCallback(async (p: Preferences) => {
    setLoadingFeed(true);
    try {
      const genres = (Object.keys(p.genres) as Genre[]).filter((g) => p.genres[g]);
      const res = await fetch("/api/feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          genres,
          favoriteTags: p.favoriteTags,
        }),
      });
      const data = await res.json();
      setFeed(data.items || []);
    } catch {
      setFeed([]);
    } finally {
      setLoadingFeed(false);
    }
  }, []);

  useEffect(() => {
    if (ready && prefs) {
      void loadFeed(prefs);
    }
  }, [ready, prefs, loadFeed]);

  const persistCollection = (items: CollectionItem[]) => {
    setCollection(items);
    saveCollection(items);
  };

  const enrich = async (item: CollectionItem) => {
    const key = cacheKey(item.artist, item.title);
    const cache = getEnrichCache();
    if (cache[key]) {
      setEnrichment({
        imageUrl: cache[key].imageUrl,
        imageCredit: cache[key].imageCredit,
        bio: cache[key].bio,
        latest: cache[key].latest,
        sourceUrls: cache[key].sourceUrls,
      });
      return;
    }

    const res = await fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: item.artist, title: item.title }),
    });
    const data = (await res.json()) as PieceEnrichment;
    setEnrichment(data);
    cache[key] = { ...data, cachedAt: new Date().toISOString() };
    saveEnrichCache(cache);
  };

  const drawPiece = async (mode: "main" | "extra") => {
    setError(null);
    if (collection.length === 0) {
      setError("先にコレクションへ作家名と作品名を登録してください。");
      setPanel("collection");
      return;
    }

    setLoadingPiece(true);
    try {
      const daily = getDailyState();
      const exclude = [
        ...(daily.mainPieceId ? [daily.mainPieceId] : []),
        ...daily.extraPieceIds,
      ];

      if (mode === "main" && daily.mainPieceId) {
        const existing = collection.find((c) => c.id === daily.mainPieceId);
        if (existing) {
          setCurrent(existing);
          setMemoDraft(existing.memo);
          await enrich(existing);
          setHasDrawnToday(true);
          return;
        }
      }

      const picked = pickPiece(collection, mode === "extra" ? exclude : []);
      if (!picked) {
        setError("出せる作品がありません。コレクションを増やしてください。");
        return;
      }

      const now = new Date().toISOString();
      const updated = collection.map((c) =>
        c.id === picked.id ? { ...c, lastShownAt: now } : c,
      );
      persistCollection(updated);

      const nextDaily =
        mode === "main"
          ? {
              date: todayKey(),
              mainPieceId: picked.id,
              extraPieceIds: daily.date === todayKey() ? daily.extraPieceIds : [],
            }
          : {
              date: todayKey(),
              mainPieceId: daily.mainPieceId,
              extraPieceIds: [...daily.extraPieceIds, picked.id],
            };
      saveDailyState(nextDaily);
      setHasDrawnToday(Boolean(nextDaily.mainPieceId));
      setCurrent(picked);
      setMemoDraft(picked.memo);
      setEnrichment(null);
      await enrich(picked);
    } finally {
      setLoadingPiece(false);
    }
  };

  const addItem = () => {
    const a = artist.trim();
    const t = title.trim();
    if (!a || !t) {
      setError("作家名と作品名を入力してください。");
      return;
    }
    const item: CollectionItem = {
      id: uid(),
      artist: a,
      title: t,
      memo: "",
      tags: [],
      lastShownAt: null,
      createdAt: new Date().toISOString(),
    };
    persistCollection([item, ...collection]);
    setArtist("");
    setTitle("");
    setError(null);
  };

  const removeItem = (id: string) => {
    persistCollection(collection.filter((c) => c.id !== id));
    if (current?.id === id) {
      setCurrent(null);
      setEnrichment(null);
    }
  };

  const saveMemoAndTags = () => {
    if (!current) return;
    const tags = tagDraft
      .split(/[,、]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const updated = collection.map((c) =>
      c.id === current.id
        ? { ...c, memo: memoDraft.trim(), tags }
        : c,
    );
    persistCollection(updated);
    setCurrent({ ...current, memo: memoDraft.trim(), tags });
    setTagDraft(tags.join(", "));
  };

  useEffect(() => {
    if (current) {
      setTagDraft(current.tags.join(", "));
      setMemoDraft(current.memo);
    }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updatePrefs = (next: Preferences) => {
    setPrefs(next);
    savePreferences(next);
  };

  if (!ready || !prefs) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[var(--muted)]">
        読み込み中…
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-6 md:py-10">
      <div className="mx-auto max-w-lg">
        <header className="mb-8 text-center">
          <p className="text-xs tracking-[0.2em] text-rose-300/80 mb-2">
            LOVEARCHIVE
          </p>
          <h1 className="text-3xl font-black text-white mb-1">ラブアカ</h1>
          <p className="text-sm text-[var(--muted)]">
            自分の好きを思い出す（活用）する
          </p>
          <p className="text-xs text-[var(--muted)]/80 mt-1">
            好きの棚を、毎日ひらく
          </p>
        </header>

        <nav className="mb-6 grid grid-cols-3 gap-2">
          {(
            [
              ["home", "ひらく"],
              ["collection", "コレクション"],
              ["settings", "好み設定"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setPanel(key)}
              className={`rounded-full px-3 py-2 text-sm font-medium transition ${
                panel === key
                  ? "bg-rose-500 text-white"
                  : "bg-white/5 text-[var(--muted)] hover:bg-white/10"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {error && (
          <div className="mb-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            {error}
          </div>
        )}

        {panel === "home" && (
          <section className="space-y-6">
            <div className="flex flex-col items-center">
              <button
                type="button"
                disabled={loadingPiece}
                onClick={() => void drawPiece(hasDrawnToday ? "extra" : "main")}
                className="group relative h-28 w-28 rounded-full bg-gradient-to-br from-rose-500 to-violet-600 shadow-lg shadow-rose-500/30 transition hover:scale-[1.03] active:scale-95 disabled:opacity-60"
              >
                <span className="text-center text-sm font-bold leading-tight text-white">
                  {loadingPiece ? (
                    "取得中…"
                  ) : hasDrawnToday ? (
                    <>
                      もう一枚
                      <br />
                      見る
                    </>
                  ) : (
                    <>
                      今日の
                      <br />
                      一枚
                    </>
                  )}
                </span>
              </button>
              <p className="mt-3 text-xs text-[var(--muted)]">
                {collection.length === 0
                  ? "まずコレクションを登録"
                  : hasDrawnToday
                    ? "今日の一枚は決定済み。追加で引けます"
                    : "最近出していない作品を優先してランダム"}
              </p>
            </div>

            {current && (
              <article className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                {enrichment?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={enrichment.imageUrl}
                    alt={`${current.artist} ${current.title}`}
                    className="h-52 w-full object-cover"
                  />
                ) : (
                  <div className="flex h-52 items-center justify-center bg-gradient-to-br from-rose-950/60 to-violet-950/60 px-6 text-center">
                    <div>
                      <p className="text-lg font-black text-white">
                        {current.title}
                      </p>
                      <p className="mt-1 text-sm text-rose-200">
                        {current.artist}
                      </p>
                      <p className="mt-3 text-[11px] text-[var(--muted)]">
                        文字カード（画像が見つからない／未取得）
                      </p>
                    </div>
                  </div>
                )}
                <div className="space-y-3 p-4">
                  <div>
                    <h2 className="text-xl font-bold text-white">
                      {current.title}
                    </h2>
                    <p className="text-sm text-rose-300">{current.artist}</p>
                    {enrichment?.imageCredit && (
                      <p className="mt-1 text-[10px] text-[var(--muted)]">
                        {enrichment.imageCredit}
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="mb-1 text-[11px] font-medium text-violet-300">
                      略歴
                    </p>
                    <p className="text-sm leading-relaxed text-[var(--muted)]">
                      {enrichment?.bio ||
                        (loadingPiece ? "読み込み中…" : "—")}
                    </p>
                  </div>

                  <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-3">
                    <p className="mb-1 text-[11px] font-medium text-violet-300">
                      最新
                    </p>
                    <p className="text-sm leading-relaxed text-violet-50/90">
                      {enrichment?.latest ||
                        (loadingPiece ? "読み込み中…" : "—")}
                    </p>
                  </div>

                  {enrichment?.sourceUrls?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {enrichment.sourceUrls.map((s) => (
                        <a
                          key={s.url}
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-[var(--muted)] hover:border-rose-400/40 hover:text-white"
                        >
                          {s.label}
                        </a>
                      ))}
                    </div>
                  ) : null}

                  <div className="space-y-2 border-t border-white/10 pt-3">
                    <label className="block text-[11px] text-[var(--muted)]">
                      一言メモ
                      <textarea
                        value={memoDraft}
                        onChange={(e) => setMemoDraft(e.target.value)}
                        rows={2}
                        className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-rose-400/50"
                        placeholder="今日の気分、思い出したこと…"
                      />
                    </label>
                    <label className="block text-[11px] text-[var(--muted)]">
                      タグ（カンマ区切り）
                      <input
                        value={tagDraft}
                        onChange={(e) => setTagDraft(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-rose-400/50"
                        placeholder="例: 好き, 再訪したい"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={saveMemoAndTags}
                      className="rounded-full bg-white/10 px-4 py-2 text-xs font-medium text-white hover:bg-white/15"
                    >
                      メモ／タグを保存
                    </button>
                  </div>
                </div>
              </article>
            )}

            <div>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-bold tracking-[0.18em] text-[var(--muted)]">
                  FOR YOU
                </h3>
                <button
                  type="button"
                  onClick={() => void loadFeed(prefs)}
                  className="text-[11px] text-rose-300 hover:text-rose-200"
                >
                  更新
                </button>
              </div>
              {loadingFeed && (
                <p className="text-sm text-[var(--muted)]">最新情報を取得中…</p>
              )}
              <div className="space-y-2">
                {feed.map((item) => (
                  <a
                    key={item.id}
                    href={item.url || "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 transition hover:border-rose-400/30"
                  >
                    <div
                      className={`flex h-9 min-w-9 shrink-0 items-center justify-center rounded-lg px-1 text-[9px] font-bold leading-tight text-center ${GENRE_STYLE[item.genre] || "bg-white/10 text-white"}`}
                    >
                      {GENRE_LABEL[item.genre]}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-white">
                        {item.title}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted)]">
                        {item.summary}
                      </p>
                    </div>
                  </a>
                ))}
                {!loadingFeed && feed.length === 0 && (
                  <p className="text-sm text-[var(--muted)]">
                    有効なジャンルがありません。好み設定を確認してください。
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {panel === "collection" && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="mb-1 text-lg font-bold text-white">
                作品を登録
              </h2>
              <p className="mb-4 text-xs text-[var(--muted)]">
                作家名と作品名だけ入力。画像・略歴・最新はAIが補います。
              </p>
              <div className="space-y-3">
                <input
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  placeholder="作家名"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-400/50"
                />
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="作品名"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-400/50"
                />
                <button
                  type="button"
                  onClick={addItem}
                  className="w-full rounded-full bg-rose-500 py-2.5 text-sm font-bold text-white hover:bg-rose-400"
                >
                  追加する
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-[var(--muted)]">
                {collection.length} 件
              </p>
              {collection.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
                >
                  <div>
                    <p className="text-sm font-bold text-white">{item.title}</p>
                    <p className="text-xs text-rose-300">{item.artist}</p>
                    {item.tags.length > 0 && (
                      <p className="mt-1 text-[10px] text-[var(--muted)]">
                        {item.tags.join(" · ")}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    className="text-[11px] text-[var(--muted)] hover:text-rose-300"
                  >
                    削除
                  </button>
                </div>
              ))}
              {collection.length === 0 && (
                <p className="text-sm text-[var(--muted)]">
                  まだありません。好きな作品を2〜3件入れてみましょう。
                </p>
              )}
            </div>
          </section>
        )}

        {panel === "settings" && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="mb-3 text-lg font-bold text-white">
                ジャンル ON / OFF
              </h2>
              <div className="space-y-3">
                {GENRE_KEYS.map((g) => (
                  <label
                    key={g}
                    className="flex items-center justify-between rounded-xl border border-white/10 px-3 py-3"
                  >
                    <span className="text-sm text-white">{GENRE_LABEL[g]}</span>
                    <input
                      type="checkbox"
                      checked={prefs.genres[g]}
                      onChange={(e) =>
                        updatePrefs({
                          ...prefs,
                          genres: { ...prefs.genres, [g]: e.target.checked },
                        })
                      }
                      className="h-4 w-4 accent-rose-500"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="mb-1 text-lg font-bold text-white">
                好きタグ / 名前
              </h2>
              <p className="mb-4 text-xs text-[var(--muted)]">
                ジャンルごとに少数。例: 作家名、監督名、ゲームシリーズ
              </p>
              {GENRE_KEYS.map((g) => (
                <div key={g} className="mb-4">
                  <p className="mb-2 text-xs font-medium text-[var(--muted)]">
                    {GENRE_LABEL[g]}
                  </p>
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {prefs.favoriteTags[g].map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() =>
                          updatePrefs({
                            ...prefs,
                            favoriteTags: {
                              ...prefs.favoriteTags,
                              [g]: prefs.favoriteTags[g].filter((t) => t !== tag),
                            },
                          })
                        }
                        className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-rose-500/30"
                      >
                        {tag} ×
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={favDraft[g]}
                      onChange={(e) =>
                        setFavDraft({ ...favDraft, [g]: e.target.value })
                      }
                      placeholder="追加…"
                      className="flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-rose-400/50"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const t = favDraft[g].trim();
                        if (!t) return;
                        if (prefs.favoriteTags[g].includes(t)) return;
                        updatePrefs({
                          ...prefs,
                          favoriteTags: {
                            ...prefs.favoriteTags,
                            [g]: [...prefs.favoriteTags[g], t],
                          },
                        });
                        setFavDraft({ ...favDraft, [g]: "" });
                      }}
                      className="rounded-full bg-white/10 px-4 text-xs text-white hover:bg-white/15"
                    >
                      追加
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => void loadFeed(prefs)}
                className="w-full rounded-full bg-violet-600 py-2.5 text-sm font-bold text-white hover:bg-violet-500"
              >
                フィードを好みで更新
              </button>
            </div>

            <p className="text-[11px] leading-relaxed text-[var(--muted)]">
              データはこのブラウザに保存されます（クラウドログインは次フェーズ）。
              AI補完を有効にするには、プロジェクト直下の{" "}
              <code className="text-rose-200">.env.local</code> に{" "}
              <code className="text-rose-200">GEMINI_API_KEY</code>{" "}
              を設定してください。
            </p>
            {activeGenres.length > 0 && (
              <p className="text-[11px] text-[var(--muted)]">
                有効ジャンル: {activeGenres.map((g) => GENRE_LABEL[g]).join(" / ")}
              </p>
            )}
          </section>
        )}

        <footer className="mt-10 text-center text-[10px] text-[var(--muted)]/70">
          LoveArchive — graduation prototype
        </footer>
      </div>
    </div>
  );
}
