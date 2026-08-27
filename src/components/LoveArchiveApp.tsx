"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  clearLocalImageFolder,
  getLocalFolderStatus,
  isLocalFolderSupported,
  LocalFolderStatus,
  pickLocalImageFolder,
  saveImagesByArtist,
} from "@/lib/localImageFolder";
import {
  deleteMedia,
  isLocalImage,
  isMediaRef,
  loadMedia,
  saveMedia,
} from "@/lib/mediaStore";
import {
  CollectionItem,
  FeedItem,
  GENRE_KEYS,
  GENRE_LABEL,
  Genre,
  MAX_ITEM_IMAGES,
  PieceEnrichment,
  Preferences,
  withSyncedImages,
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

/** 作品名は任意。未入力なら作家名を主見出しにする */
function displayTitle(item: { artist: string; title: string }) {
  return item.title.trim() || item.artist;
}

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
  const [usedImageSources, setUsedImageSources] = useState<string[]>([]);
  const [usedImageUrls, setUsedImageUrls] = useState<string[]>([]);
  const [loadingPiece, setLoadingPiece] = useState(false);
  const [loadingAltImage, setLoadingAltImage] = useState(false);
  const [altImageNote, setAltImageNote] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasDrawnToday, setHasDrawnToday] = useState(false);
  const [localFolder, setLocalFolder] = useState<LocalFolderStatus>({
    supported: false,
    configured: false,
    name: null,
  });
  const [localSaveNote, setLocalSaveNote] = useState<string | null>(null);
  /** idb: 参照 → data URL の解決済みマップ */
  const [mediaSrc, setMediaSrc] = useState<Record<string, string>>({});

  const srcFor = (url: string | null | undefined): string | null => {
    if (!url) return null;
    return isMediaRef(url) ? mediaSrc[url] || null : url;
  };

  // forms
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [itemGenre, setItemGenre] = useState<Genre>("art");
  const [formImages, setFormImages] = useState<string[]>([]);
  const formImagesRef = useRef<string[]>([]);
  const [imageDraft, setImageDraft] = useState("");
  const [formOfficialUrl, setFormOfficialUrl] = useState("");
  const [itemMemo, setItemMemo] = useState("");
  const [itemTags, setItemTags] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<
    { title: string; note?: string; imageUrl?: string }[]
  >([]);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [selectedWorks, setSelectedWorks] = useState<string[]>([]);
  const [imageResults, setImageResults] = useState<
    { url: string; note?: string }[]
  >([]);
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

  const suggestWorks = async () => {
    const a = artist.trim();
    const t = title.trim();
    if (!a || loadingSuggest) return;
    setLoadingSuggest(true);
    setSuggestNote(null);
    setSuggestions([]);
    setSelectedWorks([]);
    setImageResults([]);
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artist: a,
          title: t || undefined,
          genre: itemGenre,
        }),
      });
      const data = await res.json();
      if (t) {
        // 作品名あり → 画像候補モード
        const images = (data.images || []) as { url: string; note?: string }[];
        setImageResults(images);
        if (images.length === 0) {
          setSuggestNote(
            "画像が見つかりませんでした。URL貼り付けやスクショ登録もお試しください。",
          );
        }
        return;
      }
      const items = (data.items || []) as {
        title: string;
        note?: string;
        imageUrl?: string;
      }[];
      setSuggestions(items);
      if (items.length === 0) {
        setSuggestNote(
          "作品が見つかりませんでした。作品名を直接入力してください。",
        );
      }
    } catch {
      setSuggestNote("検索に失敗しました。もう一度お試しください。");
    } finally {
      setLoadingSuggest(false);
    }
  };

  const resetItemForm = () => {
    setEditingId(null);
    setArtist("");
    setSuggestions([]);
    setSuggestNote(null);
    setSelectedWorks([]);
    setImageResults([]);
    setTitle("");
    setItemGenre("art");
    formImagesRef.current = [];
    setFormImages([]);
    setImageDraft("");
    setFormOfficialUrl("");
    setItemMemo("");
    setItemTags("");
  };

  const parseTags = (text: string) =>
    text
      .split(/[,、]/)
      .map((t) => t.trim())
      .filter(Boolean);

  const addFormImage = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (formImagesRef.current.includes(trimmed)) {
      setError("同じ画像はすでに追加されています。");
      return false;
    }
    if (formImagesRef.current.length >= MAX_ITEM_IMAGES) {
      setError(`画像は最大${MAX_ITEM_IMAGES}枚までです。`);
      return false;
    }
    const next = [...formImagesRef.current, trimmed];
    formImagesRef.current = next;
    setFormImages(next);
    setError(null);
    return true;
  };

  const removeFormImage = (index: number) => {
    const next = formImagesRef.current.filter((_, i) => i !== index);
    formImagesRef.current = next;
    setFormImages(next);
  };

  const fileToDataUrl = async (file: File): Promise<string> => {
    const maxBytes = 1.4 * 1024 * 1024;
    const readRaw = () =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl =
            typeof reader.result === "string" ? reader.result : null;
          if (!dataUrl) reject(new Error("empty"));
          else resolve(dataUrl);
        };
        reader.onerror = () => reject(reader.error || new Error("read failed"));
        reader.readAsDataURL(file);
      });

    if (file.size <= maxBytes) {
      return readRaw();
    }

    // スクショなどが大きいときは JPEG 圧縮して保存
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("image load failed"));
        el.src = objectUrl;
      });
      const maxSide = 1600;
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (Math.max(w, h) > maxSide) {
        const scale = maxSide / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return readRaw();
      ctx.drawImage(img, 0, 0, w, h);
      let quality = 0.86;
      let dataUrl = canvas.toDataURL("image/jpeg", quality);
      while (dataUrl.length * 0.75 > maxBytes && quality > 0.35) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL("image/jpeg", quality);
      }
      if (dataUrl.length * 0.75 > maxBytes) {
        throw new Error("too large");
      }
      return dataUrl;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const handleFormImageFile = async (file: File | null) => {
    if (!file) return false;
    if (!file.type.startsWith("image/")) {
      setError("画像ファイルを選んでください。");
      return false;
    }
    if (formImagesRef.current.length >= MAX_ITEM_IMAGES) {
      setError(`画像は最大${MAX_ITEM_IMAGES}枚までです。`);
      return false;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      // 画像本体は IndexedDB へ。フォームには参照だけ持たせる
      const ref = await saveMedia(dataUrl);
      setMediaSrc((prev) => ({ ...prev, [ref]: dataUrl }));
      const ok = addFormImage(ref);
      if (!ok) void deleteMedia(ref);
      return ok;
    } catch {
      setError(
        "画像の読み込みに失敗しました。別の画像を試すか、サイズを小さくしてください。",
      );
      return false;
    }
  };

  const handlePasteImages = (
    e: React.ClipboardEvent | ClipboardEvent,
  ) => {
    const items = e.clipboardData?.items;
    if (!items?.length) return;

    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;

    e.preventDefault();
    // 入れ子の onPaste / window リスナーへの多重伝播を防ぐ
    e.stopPropagation();
    void (async () => {
      for (const file of imageFiles) {
        const ok = await handleFormImageFile(file);
        if (!ok && formImagesRef.current.length >= MAX_ITEM_IMAGES) break;
      }
    })();
  };

  /** 旧データ移行: localStorage 内の data URL 画像を IndexedDB へ移す */
  const migrationStarted = useRef(false);
  const migrateLocalImages = async () => {
    if (migrationStarted.current) return;
    migrationStarted.current = true;
    const items = getCollection();
    let changed = false;
    const next: CollectionItem[] = [];
    for (const item of items) {
      let itemChanged = false;
      const urls: string[] = [];
      for (const u of item.imageUrls || []) {
        if (u.startsWith("data:")) {
          try {
            urls.push(await saveMedia(u));
            itemChanged = true;
          } catch {
            urls.push(u);
          }
        } else {
          urls.push(u);
        }
      }
      if (itemChanged) {
        changed = true;
        // 旧 imageUrl フィールドに残る data URL を持ち込まないよう明示的に上書き
        next.push(
          withSyncedImages({ ...item, imageUrls: urls, imageUrl: urls[0] || null }),
        );
      } else {
        next.push(item);
      }
    }
    if (changed) {
      setCollection(next);
      saveCollection(next);
    }

    // enrichCache に紛れ込んだ data URL も除去（localStorage 節約）
    const cache = getEnrichCache();
    let cacheChanged = false;
    for (const k of Object.keys(cache)) {
      if (cache[k].imageUrl?.startsWith("data:")) {
        cache[k].imageUrl = null;
        cacheChanged = true;
      }
    }
    if (cacheChanged) saveEnrichCache(cache);
  };

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
        void (async () => {
          setLoadingPiece(true);
          try {
            await enrich(item);
          } finally {
            setLoadingPiece(false);
          }
        })();
      }
    }
    setReady(true);
    void getLocalFolderStatus().then(setLocalFolder);
    void migrateLocalImages();
  }, []);

  // idb: 参照の画像を表示用 data URL に解決
  useEffect(() => {
    const refs = new Set<string>();
    for (const u of formImages) if (isMediaRef(u)) refs.add(u);
    for (const item of collection) {
      const u = item.imageUrls?.[0];
      if (isMediaRef(u)) refs.add(u);
    }
    const enrichmentUrl = enrichment?.imageUrl;
    if (isMediaRef(enrichmentUrl)) refs.add(enrichmentUrl);
    const missing = Array.from(refs).filter((r) => !mediaSrc[r]);
    if (missing.length === 0) return;
    void (async () => {
      const resolved: Record<string, string> = {};
      for (const r of missing) {
        const v = await loadMedia(r);
        if (v) resolved[r] = v;
      }
      if (Object.keys(resolved).length > 0) {
        setMediaSrc((prev) => ({ ...prev, ...resolved }));
      }
    })();
  }, [collection, formImages, enrichment, mediaSrc]);

  const persistImagesToPc = async (item: {
    artist: string;
    title: string;
    imageUrls: string[];
  }) => {
    if (!item.imageUrls.length || !localFolder.configured) return;
    try {
      const saved = await saveImagesByArtist({
        artist: item.artist,
        title: item.title,
        imageUrls: item.imageUrls,
      });
      if (saved > 0) {
        setLocalSaveNote(
          `PCフォルダへ ${saved} 枚保存しました（${localFolder.name}/${item.artist}/）`,
        );
      }
    } catch {
      setLocalSaveNote("PCフォルダへの保存に失敗しました。設定でフォルダを再選択してください。");
    }
  };

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

  const enrich = async (
    item: CollectionItem,
    options?: {
      forceAuto?: boolean;
      excludeSources?: string[];
      excludeUrls?: string[];
      alternate?: boolean;
    },
  ) => {
    const forceAuto = Boolean(options?.forceAuto);
    const alternate = Boolean(options?.alternate);
    const excludeSources = options?.excludeSources || [];
    const excludeUrls = options?.excludeUrls || [];
    const key = cacheKey(item.artist, item.title, item.genre);
    const cache = getEnrichCache();

    if (
      !forceAuto &&
      !alternate &&
      cache[key] &&
      !(item.imageUrls?.length > 0) &&
      !item.officialUrl
    ) {
      setEnrichment({
        imageUrl: cache[key].imageUrl,
        imageCredit: cache[key].imageCredit,
        imageSource: cache[key].imageSource ?? null,
        bio: cache[key].bio,
        latest: cache[key].latest,
        sourceUrls: cache[key].sourceUrls,
      });
      const src = cache[key].imageSource;
      const url = cache[key].imageUrl;
      setUsedImageSources(src ? [src] : []);
      setUsedImageUrls(url ? [url] : []);
      setAltImageNote(null);
      return;
    }

    if (!forceAuto && !alternate && item.imageUrls?.length && cache[key]) {
      // 登録URLはサーバー側で og:image 解決もするので、再取得する
    }

    const primaryRegistered = item.imageUrls?.[0] || item.imageUrl || null;
    const isDataImage = Boolean(
      isLocalImage(primaryRegistered) && !forceAuto && !alternate,
    );

    const res = await fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artist: item.artist,
        title: item.title,
        genre: item.genre,
        imageUrl:
          forceAuto || alternate || isDataImage ? null : primaryRegistered,
        officialUrl: forceAuto || alternate ? null : item.officialUrl,
        forceAuto: forceAuto || alternate,
        excludeSources: alternate ? excludeSources : [],
        excludeUrls: alternate ? excludeUrls : [],
      }),
    });
    const raw = (await res.json()) as PieceEnrichment & { error?: string };
    const data: PieceEnrichment = isDataImage
      ? {
          ...raw,
          imageUrl: primaryRegistered,
          imageCredit: "手動で追加した画像",
          imageSource: "registered",
        }
      : {
          imageUrl: raw.imageUrl,
          imageCredit: raw.imageCredit,
          imageSource: raw.imageSource ?? null,
          bio: raw.bio,
          latest: raw.latest,
          sourceUrls: raw.sourceUrls,
        };
    if (!alternate) {
      setEnrichment({
        imageUrl: data.imageUrl,
        imageCredit: data.imageCredit,
        imageSource: data.imageSource ?? null,
        bio: data.bio,
        latest: data.latest,
        sourceUrls: data.sourceUrls,
      });
      const src = data.imageSource ?? null;
      const url = data.imageUrl;
      setUsedImageSources(src ? [src] : []);
      setUsedImageUrls(url ? [url] : []);
      setAltImageNote(null);
      cache[key] = {
        // data URL / idb 参照は localStorage に入れない（容量対策）
        imageUrl: isLocalImage(data.imageUrl) ? null : data.imageUrl,
        imageCredit: data.imageCredit,
        imageSource: data.imageSource ?? null,
        bio: data.bio,
        latest: data.latest,
        sourceUrls: data.sourceUrls,
        cachedAt: new Date().toISOString(),
      };
      saveEnrichCache(cache);
      return;
    }

    // 他の画像: 画像だけ差し替え（略歴などは維持）
    if (data.imageUrl) {
      setEnrichment((prev) =>
        prev
          ? {
              ...prev,
              imageUrl: data.imageUrl,
              imageCredit: data.imageCredit,
              imageSource: data.imageSource ?? null,
            }
          : {
              imageUrl: data.imageUrl,
              imageCredit: data.imageCredit,
              imageSource: data.imageSource ?? null,
              bio: data.bio,
              latest: data.latest,
              sourceUrls: data.sourceUrls,
            },
      );
      const src = data.imageSource;
      if (src) {
        setUsedImageSources((prev) =>
          prev.includes(src) ? prev : [...prev, src],
        );
      }
      setUsedImageUrls((prev) =>
        prev.includes(data.imageUrl!) ? prev : [...prev, data.imageUrl!],
      );
      setAltImageNote(null);
    } else {
      setAltImageNote("他の候補画像は見つかりませんでした");
    }
  };

  const showOtherImage = async () => {
    if (!current || loadingAltImage || loadingPiece) return;
    setLoadingAltImage(true);
    setAltImageNote(null);
    try {
      const currentUrl = enrichment?.imageUrl;
      const registered = current.imageUrls || [];
      const nextRegistered = registered.find(
        (u) => u !== currentUrl && !usedImageUrls.includes(u),
      );

      if (nextRegistered) {
        if (isLocalImage(nextRegistered)) {
          setEnrichment((prev) =>
            prev
              ? {
                  ...prev,
                  imageUrl: nextRegistered,
                  imageCredit: "手動で追加した画像",
                  imageSource: "registered",
                }
              : prev,
          );
          setUsedImageUrls((prev) =>
            prev.includes(nextRegistered) ? prev : [...prev, nextRegistered],
          );
          setUsedImageSources((prev) =>
            prev.includes("registered") ? prev : [...prev, "registered"],
          );
          return;
        }

        const res = await fetch("/api/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artist: current.artist,
            title: current.title,
            genre: current.genre,
            imageUrl: nextRegistered,
            officialUrl: null,
            forceAuto: false,
          }),
        });
        const data = (await res.json()) as PieceEnrichment;
        if (data.imageUrl) {
          setEnrichment((prev) =>
            prev
              ? {
                  ...prev,
                  imageUrl: data.imageUrl,
                  imageCredit: data.imageCredit || "登録した画像URL",
                  imageSource: data.imageSource || "registered",
                }
              : prev,
          );
          setUsedImageUrls((prev) => {
            const next = [...prev];
            if (!next.includes(nextRegistered)) next.push(nextRegistered);
            if (data.imageUrl && !next.includes(data.imageUrl)) {
              next.push(data.imageUrl);
            }
            return next;
          });
          setUsedImageSources((prev) =>
            prev.includes("registered") ? prev : [...prev, "registered"],
          );
          return;
        }
      }

      // 登録した公式HPのスクショ（まだ見ていなければ）
      if (
        current.officialUrl &&
        !usedImageSources.includes("official") &&
        enrichment?.imageSource !== "official"
      ) {
        const res = await fetch("/api/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artist: current.artist,
            title: current.title,
            genre: current.genre,
            imageUrl: null,
            officialUrl: current.officialUrl,
            forceAuto: false,
            excludeSources: ["registered"],
            excludeUrls: usedImageUrls,
          }),
        });
        const data = (await res.json()) as PieceEnrichment;
        if (data.imageUrl && data.imageUrl !== currentUrl) {
          setEnrichment((prev) =>
            prev
              ? {
                  ...prev,
                  imageUrl: data.imageUrl,
                  imageCredit:
                    data.imageCredit || "公式サイトのスクリーンショット",
                  imageSource: "official",
                }
              : prev,
          );
          setUsedImageUrls((prev) =>
            data.imageUrl && !prev.includes(data.imageUrl)
              ? [...prev, data.imageUrl]
              : prev,
          );
          setUsedImageSources((prev) =>
            prev.includes("official") ? prev : [...prev, "official"],
          );
          return;
        }
      }

      const currentSource = enrichment?.imageSource;
      const excludeSources = [
        ...usedImageSources,
        ...(currentSource ? [currentSource] : []),
        "registered",
        "official",
      ];
      const excludeUrls = [
        ...usedImageUrls,
        ...(currentUrl ? [currentUrl] : []),
        ...registered,
      ];
      await enrich(current, {
        forceAuto: true,
        alternate: true,
        excludeSources: Array.from(new Set(excludeSources)),
        excludeUrls: Array.from(new Set(excludeUrls)),
      });
    } finally {
      setLoadingAltImage(false);
    }
  };

  const handleImageError = () => {
    if (!current) return;
    setEnrichment((prev) =>
      prev
        ? {
            ...prev,
            imageUrl: null,
            imageCredit: "画像の読み込みに失敗したため、自動取得を再試行します",
            imageSource: null,
          }
        : prev,
    );
    void enrich(current, { forceAuto: true });
  };

  const drawPiece = async (mode: "main" | "extra") => {
    setError(null);
    if (collection.length === 0) {
      setError("先にコレクションへ作家名を登録してください。");
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
      setUsedImageSources([]);
      setUsedImageUrls([]);
      setAltImageNote(null);
      await enrich(picked);
    } finally {
      setLoadingPiece(false);
    }
  };

  /** 選択した候補をまとめてコレクションに登録 */
  const bulkAddSelected = () => {
    const a = artist.trim();
    if (!a || selectedWorks.length === 0) return;
    const now = new Date().toISOString();
    const newItems = suggestions
      .filter((s) => selectedWorks.includes(s.title))
      .filter(
        (s) => !collection.some((c) => c.artist === a && c.title === s.title),
      )
      .map((s) =>
        withSyncedImages({
          id: uid(),
          artist: a,
          title: s.title,
          genre: itemGenre,
          imageUrls: s.imageUrl ? [s.imageUrl] : [],
          officialUrl: null,
          memo: "",
          tags: [],
          lastShownAt: null,
          createdAt: now,
        }),
      );
    if (newItems.length === 0) {
      setSelectedWorks([]);
      return;
    }
    persistCollection([...newItems, ...collection]);
    for (const item of newItems) void persistImagesToPc(item);
    setSelectedWorks([]);
    setLocalSaveNote(`${newItems.length} 件をコレクションに登録しました。`);
    setError(null);
  };

  const addItem = () => {
    const a = artist.trim();
    const t = title.trim();
    if (!a) {
      setError("作家名を入力してください。");
      return;
    }
    const images = [...formImages];
    if (imageDraft.trim()) {
      if (images.length >= MAX_ITEM_IMAGES) {
        setError(`画像は最大${MAX_ITEM_IMAGES}枚までです。`);
        return;
      }
      if (!images.includes(imageDraft.trim())) {
        images.push(imageDraft.trim());
      }
    }
    const item = withSyncedImages({
      id: uid(),
      artist: a,
      title: t,
      genre: itemGenre,
      imageUrls: images,
      officialUrl: formOfficialUrl.trim() || null,
      memo: itemMemo.trim(),
      tags: parseTags(itemTags),
      lastShownAt: null,
      createdAt: new Date().toISOString(),
    });
    persistCollection([item, ...collection]);
    void persistImagesToPc(item);
    resetItemForm();
    setError(null);
  };

  const startEditItem = (item: CollectionItem) => {
    setEditingId(item.id);
    setArtist(item.artist);
    setTitle(item.title);
    setItemGenre(item.genre);
    const images = [...(item.imageUrls || [])];
    formImagesRef.current = images;
    setFormImages(images);
    setImageDraft("");
    setFormOfficialUrl(item.officialUrl || "");
    setItemMemo(item.memo || "");
    setItemTags(item.tags.join(", "));
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveEditedItem = () => {
    if (!editingId) return;
    const a = artist.trim();
    const t = title.trim();
    if (!a) {
      setError("作家名を入力してください。");
      return;
    }

    const prev = collection.find((c) => c.id === editingId);
    if (!prev) {
      setError("編集対象が見つかりません。");
      return;
    }

    const images = [...formImages];
    if (imageDraft.trim()) {
      if (images.length >= MAX_ITEM_IMAGES) {
        setError(`画像は最大${MAX_ITEM_IMAGES}枚までです。`);
        return;
      }
      if (!images.includes(imageDraft.trim())) {
        images.push(imageDraft.trim());
      }
    }

    const next = withSyncedImages({
      ...prev,
      artist: a,
      title: t,
      genre: itemGenre,
      imageUrls: images,
      officialUrl: formOfficialUrl.trim() || null,
      memo: itemMemo.trim(),
      tags: parseTags(itemTags),
    });

    const identityChanged =
      prev.artist !== next.artist ||
      prev.title !== next.title ||
      prev.genre !== next.genre;

    if (identityChanged) {
      const cache = getEnrichCache();
      delete cache[cacheKey(prev.artist, prev.title, prev.genre)];
      saveEnrichCache(cache);
    }

    // 編集で外された idb 画像は IndexedDB からも削除
    for (const u of prev.imageUrls || []) {
      if (isMediaRef(u) && !next.imageUrls.includes(u)) void deleteMedia(u);
    }

    persistCollection(
      collection.map((c) => (c.id === editingId ? next : c)),
    );
    void persistImagesToPc(next);

    if (current?.id === editingId) {
      setCurrent(next);
      setMemoDraft(next.memo);
      setTagDraft(next.tags.join(", "));
      const imagesChanged =
        JSON.stringify(prev.imageUrls) !== JSON.stringify(next.imageUrls) ||
        prev.officialUrl !== next.officialUrl;
      if (identityChanged || imagesChanged) {
        setEnrichment(null);
        setUsedImageSources([]);
        setUsedImageUrls([]);
        setAltImageNote(null);
        void enrich(next);
      }
    }

    resetItemForm();
    setError(null);
  };

  const removeItem = (id: string) => {
    if (editingId === id) resetItemForm();
    const removed = collection.find((c) => c.id === id);
    for (const u of removed?.imageUrls || []) {
      if (isMediaRef(u)) void deleteMedia(u);
    }
    persistCollection(collection.filter((c) => c.id !== id));
    if (current?.id === id) {
      setCurrent(null);
      setEnrichment(null);
      setUsedImageSources([]);
      setUsedImageUrls([]);
      setAltImageNote(null);
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

  // コレクション画面でスクショ貼り付け（Ctrl+V / Cmd+V）
  useEffect(() => {
    if (panel !== "collection") return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      void (async () => {
        for (const file of imageFiles) {
          const ok = await handleFormImageFile(file);
          if (!ok && formImagesRef.current.length >= MAX_ITEM_IMAGES) break;
        }
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [panel]); // eslint-disable-line react-hooks/exhaustive-deps

  const updatePrefs = (next: Preferences) => {
    setPrefs(next);
    savePreferences(next);
  };

  /** コレクション一式を JSON ファイルとしてダウンロード（idb 画像は data URL に展開） */
  const [exporting, setExporting] = useState(false);
  const exportCollection = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const items = getCollection();
      const resolved: CollectionItem[] = [];
      for (const item of items) {
        const urls: string[] = [];
        for (const u of item.imageUrls || []) {
          if (isMediaRef(u)) {
            const v = await loadMedia(u);
            if (v) urls.push(v);
          } else {
            urls.push(u);
          }
        }
        resolved.push({ ...item, imageUrls: urls, imageUrl: urls[0] || null });
      }
      const payload = {
        app: "lovearchive",
        version: 1,
        exportedAt: new Date().toISOString(),
        collection: resolved,
        preferences: getPreferences(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lovearchive-backup-${todayKey()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setLocalSaveNote(
        `コレクション ${resolved.length} 件をダウンロードしました。`,
      );
    } catch {
      setError("エクスポートに失敗しました。もう一度お試しください。");
    } finally {
      setExporting(false);
    }
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
          <svg
            viewBox="0 0 200 200"
            className="mx-auto mb-2 h-14 w-14 drop-shadow-lg"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="laFolderBack" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#E91E63" />
                <stop offset="60%" stopColor="#7B1FA2" />
                <stop offset="100%" stopColor="#1E88E5" />
              </linearGradient>
              <linearGradient id="laFolderFront" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#FF2A7A" />
                <stop offset="50%" stopColor="#8E24AA" />
                <stop offset="100%" stopColor="#2979FF" />
              </linearGradient>
            </defs>
            <g transform="translate(4, 18)">
              <path
                d="M 25,25 L 75,25 Q 85,25 92,35 L 105,52 Q 110,58 120,58 L 180,58 Q 192,58 192,70 L 192,145 Q 192,155 180,155 L 25,155 Q 15,155 15,145 L 15,37 Q 15,25 25,25 Z"
                fill="url(#laFolderBack)"
                opacity="0.95"
              />
              <path
                d="M 25,48 L 175,48 Q 190,48 185,65 L 165,148 Q 162,158 150,158 L 18,158 Q 6,158 10,146 L 22,58 Q 24,48 25,48 Z"
                fill="url(#laFolderFront)"
              />
              <path
                d="M 26,50 L 173,50"
                stroke="rgba(255,255,255,0.4)"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
              <path
                d="M 98,82 C 98,72 88,65 77,65 C 66,65 59,73 59,81 C 59,73 52,65 41,65 C 30,65 20,72 20,82 C 20,102 59,128 59,128 C 59,128 98,102 98,82 Z"
                transform="translate(42, 5)"
                fill="#FFFFFF"
              />
            </g>
          </svg>
          <p className="text-xs tracking-[0.2em] text-rose-300/80 mb-2">
            LOVEARCHIVE
          </p>
          <h1 className="mb-1 bg-gradient-to-r from-rose-300 via-rose-200 to-violet-300 bg-clip-text text-3xl font-black text-transparent">
            ラブアカ
          </h1>
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
              aria-current={panel === key ? "page" : undefined}
              className={`rounded-full px-3 py-2 text-sm font-medium transition ${
                panel === key
                  ? "bg-rose-500 text-white shadow-lg shadow-rose-500/25"
                  : "bg-white/5 text-[var(--muted)] hover:bg-white/10 hover:text-white"
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
        {localSaveNote && (
          <div className="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
            {localSaveNote}
            <button
              type="button"
              onClick={() => setLocalSaveNote(null)}
              className="ml-2 text-[11px] underline opacity-80"
            >
              閉じる
            </button>
          </div>
        )}

        {panel === "home" && (
          <section className="space-y-6">
            <div className="flex flex-col items-center">
              <button
                type="button"
                disabled={loadingPiece}
                onClick={() => void drawPiece(hasDrawnToday ? "extra" : "main")}
                className={`group relative rounded-full bg-gradient-to-br from-rose-500 to-violet-600 ring-1 ring-white/15 transition [animation:la-breathe_4s_ease-in-out_infinite] hover:scale-[1.03] active:scale-95 disabled:opacity-60 motion-reduce:[animation:none] motion-reduce:shadow-lg motion-reduce:shadow-rose-500/30 ${
                  current ? "h-16 w-16" : "h-28 w-28"
                }`}
              >
                <span
                  className={`text-center font-bold leading-tight text-white ${
                    current ? "text-[10px]" : "text-sm"
                  }`}
                >
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
              {collection.length === 0 ? (
                <p className="mt-3 text-xs text-[var(--muted)]">
                  まずコレクションを登録
                </p>
              ) : !hasDrawnToday && !current ? (
                <p className="mt-3 text-xs text-[var(--muted)]">
                  最近出していない作品を優先してランダム
                </p>
              ) : null}
            </div>

            {current && (
              <article className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xl shadow-black/40">
                {srcFor(enrichment?.imageUrl) ? (
                  <div className="relative aspect-square w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={srcFor(enrichment?.imageUrl)!}
                      alt={`${current.artist} ${current.title}`}
                      className="h-full w-full object-contain bg-black/20"
                      onError={handleImageError}
                    />
                    <button
                      type="button"
                      onClick={() => void showOtherImage()}
                      disabled={loadingAltImage || loadingPiece}
                      className="absolute bottom-2 right-2 rounded-full bg-black/65 px-3 py-1.5 text-[11px] font-medium text-white backdrop-blur-sm hover:bg-black/80 disabled:opacity-60"
                    >
                      {loadingAltImage ? "取得中…" : "他の画像を表示"}
                    </button>
                    {altImageNote && (
                      <p className="absolute bottom-10 right-2 max-w-[80%] rounded-md bg-black/70 px-2 py-1 text-[10px] text-rose-100">
                        {altImageNote}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center bg-gradient-to-br from-rose-950/60 to-violet-950/60 px-6 text-center">
                    <div>
                      <p className="text-lg font-black text-white">
                        {displayTitle(current)}
                      </p>
                      {current.title.trim() && (
                        <p className="mt-1 text-sm text-rose-200">
                          {current.artist}
                        </p>
                      )}
                      <p className="mt-3 text-[11px] text-[var(--muted)]">
                        {loadingPiece
                          ? "画像を取得中…"
                          : "文字カード（画像未取得）"}
                      </p>
                      {!loadingPiece && (
                        <button
                          type="button"
                          onClick={() => void enrich(current, { forceAuto: true })}
                          className="mt-3 rounded-full bg-white/10 px-3 py-1.5 text-[11px] text-white hover:bg-white/15"
                        >
                          画像を自動取得し直す
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div className="space-y-3 p-4">
                  <div>
                    {current.genre && (
                      <span
                        className={`mb-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${GENRE_STYLE[current.genre]}`}
                      >
                        {GENRE_LABEL[current.genre]}
                      </span>
                    )}
                    <h2 className="text-xl font-bold text-white">
                      {displayTitle(current)}
                    </h2>
                    {current.title.trim() && (
                      <p className="text-sm text-rose-300">{current.artist}</p>
                    )}
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
                    className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 transition hover:border-rose-400/30 hover:bg-white/[0.03]"
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
            <div
              id="collection-form"
              className={`rounded-2xl border p-4 ${
                editingId
                  ? "border-rose-400/40 bg-rose-500/10"
                  : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              <h2 className="mb-1 text-lg font-bold text-white">
                {editingId ? "作品を編集" : "作品を登録"}
              </h2>
              <p className="mb-4 text-xs text-[var(--muted)]">
                {editingId
                  ? "内容を直して「変更を保存」を押してください。"
                  : "ジャンル・作家名を入力（作品名は任意）。画像・略歴・最新はAIが補います。"}
              </p>
              <div className="space-y-3">
                <div>
                  <p className="mb-2 text-[11px] text-[var(--muted)]">ジャンル</p>
                  <div className="flex flex-wrap gap-2">
                    {GENRE_KEYS.map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setItemGenre(g)}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                          itemGenre === g
                            ? "bg-rose-500 text-white"
                            : `${GENRE_STYLE[g]} border border-white/10 hover:border-rose-400/40`
                        }`}
                      >
                        {GENRE_LABEL[g]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <input
                    value={artist}
                    onChange={(e) => setArtist(e.target.value)}
                    placeholder="作家名"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-400/50"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void suggestWorks();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void suggestWorks()}
                    disabled={!artist.trim() || loadingSuggest}
                    className="shrink-0 rounded-xl bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
                  >
                    {loadingSuggest
                      ? "検索中…"
                      : title.trim()
                        ? "画像を探す"
                        : "作品を探す"}
                  </button>
                </div>
                <p className="text-[10px] text-[var(--muted)]">
                  作家名だけ → 作品の候補 / 作家名＋作品名 → その作品の画像候補
                </p>
                {suggestNote && (
                  <p className="text-[11px] text-[var(--muted)]">{suggestNote}</p>
                )}
                {suggestions.length > 0 && (
                  <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-2.5">
                    <p className="mb-1.5 text-[10px] text-violet-200/80">
                      タップで選択して、まとめて登録できます（画像も一緒に登録されます）
                    </p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {suggestions.map((s) => {
                        const registered = collection.some(
                          (c) =>
                            c.artist === artist.trim() && c.title === s.title,
                        );
                        const selected = selectedWorks.includes(s.title);
                        return (
                          <button
                            key={s.title}
                            type="button"
                            disabled={registered}
                            onClick={() =>
                              setSelectedWorks((prev) =>
                                prev.includes(s.title)
                                  ? prev.filter((t) => t !== s.title)
                                  : [...prev, s.title],
                              )
                            }
                            className={`relative overflow-hidden rounded-lg border text-left transition ${
                              registered
                                ? "border-white/5 opacity-40"
                                : selected
                                  ? "border-rose-400 bg-rose-500/20"
                                  : "border-white/10 bg-black/20 hover:border-rose-400/40"
                            }`}
                          >
                            {s.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={s.imageUrl}
                                alt=""
                                loading="lazy"
                                className="h-20 w-full bg-black/30 object-cover"
                                onError={(e) => {
                                  e.currentTarget.style.display = "none";
                                }}
                              />
                            ) : (
                              <div className="flex h-20 w-full items-center justify-center bg-black/30 text-[9px] text-[var(--muted)]">
                                画像なし
                              </div>
                            )}
                            <span className="block px-1.5 py-1 text-[10px] leading-tight text-white">
                              {s.title}
                              {s.note ? (
                                <span className="ml-1 opacity-60">{s.note}</span>
                              ) : null}
                              {registered ? (
                                <span className="ml-1 text-emerald-300">
                                  登録済み
                                </span>
                              ) : null}
                            </span>
                            {selected && (
                              <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] text-white">
                                ✓
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={bulkAddSelected}
                        disabled={selectedWorks.length === 0}
                        className="flex-1 rounded-full bg-rose-500 py-2 text-xs font-bold text-white hover:bg-rose-400 disabled:opacity-40"
                      >
                        選択した {selectedWorks.length} 件を登録
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSuggestions([]);
                          setSelectedWorks([]);
                        }}
                        className="rounded-full border border-white/15 px-3 py-2 text-[11px] text-[var(--muted)] hover:text-white"
                      >
                        閉じる
                      </button>
                    </div>
                  </div>
                )}
                {imageResults.length > 0 && (
                  <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-2.5">
                    <p className="mb-1.5 text-[10px] text-violet-200/80">
                      タップで「画像」欄に追加されます（複数選択OK・もう一度タップで解除）
                    </p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {imageResults.map((im) => {
                        const addedIndex = formImages.indexOf(im.url);
                        const added = addedIndex >= 0;
                        return (
                          <button
                            key={im.url}
                            type="button"
                            onClick={() => {
                              if (added) removeFormImage(addedIndex);
                              else addFormImage(im.url);
                            }}
                            className={`relative overflow-hidden rounded-lg border text-left transition ${
                              added
                                ? "border-rose-400 bg-rose-500/20"
                                : "border-white/10 bg-black/20 hover:border-rose-400/40"
                            }`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={im.url}
                              alt=""
                              loading="lazy"
                              className="h-20 w-full bg-black/30 object-cover"
                              onError={(e) => {
                                const btn = e.currentTarget.closest("button");
                                if (btn) btn.style.display = "none";
                              }}
                            />
                            {im.note && (
                              <span className="block px-1.5 py-0.5 text-[9px] leading-tight text-[var(--muted)]">
                                {im.note}
                              </span>
                            )}
                            {added && (
                              <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] text-white">
                                ✓
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => setImageResults([])}
                      className="mt-2 rounded-full border border-white/15 px-3 py-1.5 text-[11px] text-[var(--muted)] hover:text-white"
                    >
                      閉じる
                    </button>
                  </div>
                )}
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="作品名（任意）"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-400/50"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void suggestWorks();
                    }
                  }}
                />
                <div
                  onPaste={handlePasteImages}
                  className="rounded-xl border border-dashed border-white/15 bg-black/10 p-3"
                >
                  <p className="mb-1.5 text-[11px] text-[var(--muted)]">
                    画像（任意・最大{MAX_ITEM_IMAGES}枚）
                    <span className="ml-2 text-[var(--muted)]">
                      {formImages.length}/{MAX_ITEM_IMAGES}
                    </span>
                  </p>
                  {formImages.length > 0 && (
                    <div className="mb-2 grid grid-cols-5 gap-1.5">
                      {formImages.map((url, index) => (
                        <div key={`${index}-${url.slice(0, 24)}`} className="relative">
                          {srcFor(url) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={srcFor(url)!}
                              alt=""
                              className="h-14 w-full rounded-lg object-cover bg-black/30"
                            />
                          ) : (
                            <div className="h-14 w-full rounded-lg bg-black/30" />
                          )}
                          <button
                            type="button"
                            onClick={() => removeFormImage(index)}
                            className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/80 text-[10px] text-white hover:bg-rose-600"
                            aria-label="画像を削除"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div
                    tabIndex={0}
                    onPaste={handlePasteImages}
                    className="mb-2 flex min-h-[72px] flex-col items-center justify-center rounded-xl border border-dashed border-rose-400/30 bg-rose-500/5 px-3 py-4 text-center outline-none focus:border-rose-400/60"
                  >
                    <p className="text-[12px] font-medium text-rose-100/90">
                      スクリーンショットをここに貼り付け
                    </p>
                    <p className="mt-1 text-[10px] text-[var(--muted)]">
                      Win+Shift+S などでコピー → Ctrl+V（Macは Cmd+V）
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={imageDraft}
                      onChange={(e) => setImageDraft(e.target.value)}
                      placeholder="https://…（.jpg / .png など画像URL）"
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-400/50"
                      onPaste={handlePasteImages}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (addFormImage(imageDraft)) setImageDraft("");
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (addFormImage(imageDraft)) setImageDraft("");
                      }}
                      disabled={formImages.length >= MAX_ITEM_IMAGES}
                      className="shrink-0 rounded-xl bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15 disabled:opacity-40"
                    >
                      追加
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <label
                      className={`rounded-full bg-white/10 px-3 py-1.5 text-[11px] text-white hover:bg-white/15 ${
                        formImages.length >= MAX_ITEM_IMAGES
                          ? "cursor-not-allowed opacity-40"
                          : "cursor-pointer"
                      }`}
                    >
                      ファイルから追加
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={formImages.length >= MAX_ITEM_IMAGES}
                        onChange={(e) => {
                          void handleFormImageFile(e.target.files?.[0] || null);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--muted)]">
                    画像URL・貼り付け・ファイルで最大{MAX_ITEM_IMAGES}枚。公式HPは下の欄へ。
                  </p>
                </div>
                <label className="block text-[11px] text-[var(--muted)]">
                  公式HP（任意・スクリーンショット用）
                  <input
                    value={formOfficialUrl}
                    onChange={(e) => setFormOfficialUrl(e.target.value)}
                    placeholder="https://…（公式サイトのページURL）"
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-400/50"
                  />
                  <span className="mt-1.5 block text-[10px] leading-relaxed text-[var(--muted)]">
                    ページ全体のスクショを自動取得します。画像ファイルのURLは上の「画像」欄へ。
                  </span>
                </label>
                <label className="block text-[11px] text-[var(--muted)]">
                  一言メモ
                  <textarea
                    value={itemMemo}
                    onChange={(e) => setItemMemo(e.target.value)}
                    rows={2}
                    placeholder="思い出したこと、好きな理由…"
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-rose-400/50"
                  />
                </label>
                <label className="block text-[11px] text-[var(--muted)]">
                  タグ（カンマ区切り）
                  <input
                    value={itemTags}
                    onChange={(e) => setItemTags(e.target.value)}
                    placeholder="例: 好き, 再訪したい"
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-400/50"
                  />
                </label>
                {editingId ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={saveEditedItem}
                      className="flex-1 rounded-full bg-rose-500 py-2.5 text-sm font-bold text-white hover:bg-rose-400"
                    >
                      変更を保存
                    </button>
                    <button
                      type="button"
                      onClick={resetItemForm}
                      className="rounded-full border border-white/15 px-4 py-2.5 text-sm text-[var(--muted)] hover:text-white"
                    >
                      キャンセル
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={addItem}
                    className="w-full rounded-full bg-rose-500 py-2.5 text-sm font-bold text-white hover:bg-rose-400"
                  >
                    追加する
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-[var(--muted)]">
                {collection.length} 件
              </p>
              {collection.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-xl border px-3 py-3 ${
                    editingId === item.id
                      ? "border-rose-400/50 bg-rose-500/10"
                      : "border-[var(--border)] bg-[var(--surface)]"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {srcFor(item.imageUrls?.[0]) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={srcFor(item.imageUrls?.[0])!}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-lg object-cover bg-black/30"
                      />
                    ) : (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-black/30 text-[10px] text-[var(--muted)]">
                        画像なし
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <span
                        className={`mb-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${GENRE_STYLE[item.genre] || GENRE_STYLE.art}`}
                      >
                        {GENRE_LABEL[item.genre] || GENRE_LABEL.art}
                      </span>
                      <p className="text-sm font-bold text-white">
                        {displayTitle(item)}
                      </p>
                      {item.title.trim() && (
                        <p className="text-xs text-rose-300">{item.artist}</p>
                      )}
                      {item.imageUrls?.length > 0 && (
                        <p className="mt-1 text-[10px] text-emerald-300/90">
                          画像 {item.imageUrls.length}/{MAX_ITEM_IMAGES}
                        </p>
                      )}
                      {item.officialUrl && (
                        <p className="mt-0.5 truncate text-[10px] text-sky-300/90">
                          公式HP登録済み
                        </p>
                      )}
                      {item.memo && (
                        <p className="mt-1 line-clamp-2 text-[11px] text-[var(--muted)]">
                          {item.memo}
                        </p>
                      )}
                      {item.tags.length > 0 && (
                        <p className="mt-1 text-[10px] text-[var(--muted)]">
                          {item.tags.join(" · ")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2 border-t border-white/10 pt-3">
                    <button
                      type="button"
                      onClick={() => startEditItem(item)}
                      className="flex-1 rounded-full bg-white/10 py-1.5 text-[11px] font-medium text-white hover:bg-white/15"
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="rounded-full border border-white/10 px-4 py-1.5 text-[11px] text-[var(--muted)] hover:text-rose-300"
                    >
                      削除
                    </button>
                  </div>
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
              <h2 className="mb-1 text-lg font-bold text-white">
                PCフォルダへ自動保存
              </h2>
              <p className="mb-3 text-xs leading-relaxed text-[var(--muted)]">
                作品の追加・保存時に、画像を作者名フォルダへ書き出します。
                おすすめ: プロジェクト内の{" "}
                <code className="text-rose-200/90">public/images</code>{" "}
                を選ぶ
                （例: …/lovearchive/public/images）
              </p>
              {!isLocalFolderSupported() ? (
                <p className="text-sm text-amber-200/90">
                  このブラウザでは未対応です。Chrome または Edge で開いてください。
                </p>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-white">
                    {localFolder.configured
                      ? `保存先: ${localFolder.name}`
                      : "保存先フォルダ未設定"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void (async () => {
                          try {
                            const status = await pickLocalImageFolder();
                            setLocalFolder(status);
                            setLocalSaveNote(
                              `保存先「${status.name}」を設定しました。作者別に自動保存します。`,
                            );
                            setError(null);
                          } catch (e) {
                            setError(
                              e instanceof Error
                                ? e.message
                                : "フォルダの選択に失敗しました",
                            );
                          }
                        })();
                      }}
                      className="rounded-full bg-rose-500 px-4 py-2 text-xs font-bold text-white hover:bg-rose-400"
                    >
                      {localFolder.configured
                        ? "フォルダを変更"
                        : "保存先フォルダを選ぶ"}
                    </button>
                    {localFolder.configured && (
                      <button
                        type="button"
                        onClick={() => {
                          void (async () => {
                            await clearLocalImageFolder();
                            setLocalFolder({
                              supported: true,
                              configured: false,
                              name: null,
                            });
                            setLocalSaveNote("PCフォルダ保存を解除しました。");
                          })();
                        }}
                        className="rounded-full border border-white/15 px-4 py-2 text-xs text-[var(--muted)] hover:text-white"
                      >
                        解除
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] leading-relaxed text-[var(--muted)]">
                    構成: 選んだフォルダ / 作者名 / 作品名-xxxx.jpg
                    <br />
                    ブラウザを閉じたあと、書き込み許可を再度求められることがあります。
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="mb-1 text-lg font-bold text-white">
                バックアップ
              </h2>
              <p className="mb-3 text-xs leading-relaxed text-[var(--muted)]">
                コレクション全体（画像・メモ・タグ・好み設定）を1つのファイルに
                まとめてダウンロードします。ブラウザのデータを消しても、
                このファイルがあれば復元できます。
              </p>
              <button
                type="button"
                onClick={() => void exportCollection()}
                disabled={exporting || collection.length === 0}
                className="rounded-full bg-rose-500 px-4 py-2 text-xs font-bold text-white hover:bg-rose-400 disabled:opacity-40"
              >
                {exporting
                  ? "書き出し中…"
                  : `コレクションをダウンロード（${collection.length} 件）`}
              </button>
            </div>

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
