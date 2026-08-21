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

  const resetItemForm = () => {
    setEditingId(null);
    setArtist("");
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
      return addFormImage(dataUrl);
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
    void (async () => {
      for (const file of imageFiles) {
        const ok = await handleFormImageFile(file);
        if (!ok && formImagesRef.current.length >= MAX_ITEM_IMAGES) break;
      }
    })();
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
  }, []);

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
      primaryRegistered?.startsWith("data:image/") && !forceAuto && !alternate,
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
        imageUrl: data.imageUrl,
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
        if (nextRegistered.startsWith("data:image/")) {
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
      setUsedImageSources([]);
      setUsedImageUrls([]);
      setAltImageNote(null);
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
    if (!a || !t) {
      setError("作家名と作品名を入力してください。");
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
                className="group relative h-28 w-28 rounded-full bg-gradient-to-br from-rose-500 to-violet-600 ring-1 ring-white/15 transition [animation:la-breathe_4s_ease-in-out_infinite] hover:scale-[1.03] active:scale-95 disabled:opacity-60 motion-reduce:[animation:none] motion-reduce:shadow-lg motion-reduce:shadow-rose-500/30"
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
              <article className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xl shadow-black/40">
                {enrichment?.imageUrl ? (
                  <div className="relative aspect-square w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={enrichment.imageUrl}
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
                        {current.title}
                      </p>
                      <p className="mt-1 text-sm text-rose-200">
                        {current.artist}
                      </p>
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
                  : "ジャンル・作家名・作品名を入力。画像・略歴・最新はAIが補います。"}
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
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt=""
                            className="h-14 w-full rounded-lg object-cover bg-black/30"
                          />
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
                    {item.imageUrls?.[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.imageUrls[0]}
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
                      <p className="text-sm font-bold text-white">{item.title}</p>
                      <p className="text-xs text-rose-300">{item.artist}</p>
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
