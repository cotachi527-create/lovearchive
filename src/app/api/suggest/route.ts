import { NextRequest, NextResponse } from "next/server";
import { Genre, GENRE_KEYS } from "@/lib/types";

export const maxDuration = 30;

/** Geminiに「作品」の範囲を具体的に伝えるためのジャンル別の言い回し */
const GENRE_WORK_NOUN: Record<Genre, string> = {
  art: "作品（絵画・写真集・シリーズなど）のタイトル",
  game: "ゲームタイトル",
  movie: "映画タイトル",
  book: "書籍タイトル",
  anime: "アニメ映画・アニメシリーズのタイトル",
  music: "アルバム・楽曲タイトル",
};

type SuggestItem = {
  title: string;
  note?: string;
  imageUrl?: string;
  /** 作品名だけで検索したときに見つかった作家名 */
  artist?: string;
};

type ImageCandidate = { url: string; note?: string };

type SuggestBody = {
  /** artist・title は少なくとも一方が必要 */
  artist?: string;
  title?: string;
  genre?: Genre;
};

export async function POST(req: NextRequest) {
  const body = (await req.json()) as SuggestBody;
  const artist = (body.artist || "").trim();
  const title = (body.title || "").trim();
  const genre: Genre = GENRE_KEYS.includes(body.genre as Genre)
    ? (body.genre as Genre)
    : "art";

  if (!artist && !title) {
    return NextResponse.json(
      { error: "artist または title が必要です" },
      { status: 400 },
    );
  }

  // 作家名・作品名の両方あり → その作品の画像候補を返すモード
  if (artist && title) {
    let images: ImageCandidate[] = [];
    try {
      images = await findWorkImages(artist, title, genre);
    } catch {
      images = [];
    }
    return NextResponse.json({ images: dedupeImages(images).slice(0, 12) });
  }

  // 作品名のみ → 作家名を推定しながら作品候補を返すモード
  if (!artist && title) {
    const items = await findWorksByTitle(title, genre);
    return NextResponse.json({ items: dedupe(items).slice(0, 12) });
  }

  // 作家名のみ → 代表作の候補を返すモード
  // Gemini（キーがあれば最優先。ジャンル問わず質が高いが画像は返さない）と
  // 無料API（画像は取れるがリストの質はまちまち）を並行して取得し、
  // Geminiの候補リストに無料API側の画像を補って返す
  const [geminiResult, freeApiResult] = await Promise.allSettled([
    viaGemini(artist, genre),
    freeApiItemsByArtist(artist, genre),
  ]);
  const fromGemini =
    geminiResult.status === "fulfilled" ? geminiResult.value : [];
  const freeItems =
    freeApiResult.status === "fulfilled" ? freeApiResult.value : [];

  if (fromGemini.length > 0) {
    const imageByTitle = new Map<string, string>();
    for (const it of freeItems) {
      if (it.imageUrl) {
        const key = normKey(it.title);
        if (!imageByTitle.has(key)) imageByTitle.set(key, it.imageUrl);
      }
    }
    const merged = fromGemini.map((it) =>
      it.imageUrl
        ? it
        : { ...it, imageUrl: imageByTitle.get(normKey(it.title)) },
    );
    return NextResponse.json({ items: merged.slice(0, 12) });
  }

  return NextResponse.json({ items: dedupe(freeItems).slice(0, 12) });
}

/** 表記ゆれを吸収した比較用キー（同じ作品名かどうかの突き合わせに使う） */
function normKey(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s　:：・「」『』()（）\-–—]/g, "");
}

/** ジャンル別の無料APIを試し、ダメならWikidataへ（画像を持つ候補を集める） */
async function freeApiItemsByArtist(
  artist: string,
  genre: Genre,
): Promise<SuggestItem[]> {
  let items: SuggestItem[] = [];
  try {
    if (genre === "book") items = await viaBooks(artist);
    else if (genre === "music") items = await viaMusicBrainz(artist);
    else if (genre === "anime") items = await viaAniList(artist);
  } catch {
    items = [];
  }
  if (items.length === 0) {
    try {
      items = await viaWikidata(artist);
    } catch {
      items = [];
    }
  }
  return items;
}

function dedupe(items: SuggestItem[]): SuggestItem[] {
  const seen = new Map<string, SuggestItem>();
  for (const item of items) {
    const titleKey = item.title.trim().toLowerCase();
    if (!titleKey) continue;
    // 作家名が異なれば同名でも別候補として残す（同名異作家の作品名検索向け）
    const key = `${(item.artist || "").trim().toLowerCase()}::${titleKey}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, {
        ...item,
        title: item.title.trim(),
        artist: item.artist?.trim() || undefined,
      });
    } else if (!existing.imageUrl && item.imageUrl) {
      // 同名の候補は画像を持つ方を優先
      existing.imageUrl = item.imageUrl;
    }
  }
  return Array.from(seen.values());
}

function dedupeImages(images: ImageCandidate[]): ImageCandidate[] {
  const seen = new Set<string>();
  const out: ImageCandidate[] = [];
  for (const img of images) {
    if (!img.url || seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img);
  }
  return out;
}

/** 作品名だけで検索: 作家名を推定しながら候補を集める */
async function findWorksByTitle(
  title: string,
  genre: Genre,
): Promise<SuggestItem[]> {
  const [geminiResult, freeApiResult] = await Promise.allSettled([
    viaGeminiByTitle(title, genre),
    freeApiItemsByTitle(title, genre),
  ]);
  const fromGemini =
    geminiResult.status === "fulfilled" ? geminiResult.value : [];
  const freeItems =
    freeApiResult.status === "fulfilled" ? freeApiResult.value : [];

  if (fromGemini.length > 0) {
    // 同じ作品名でも作家が違えば別作品なので、作家名も一致した場合だけ画像を補う
    const imageByKey = new Map<string, string>();
    for (const it of freeItems) {
      if (it.imageUrl) {
        const key = `${normKey(it.artist || "")}::${normKey(it.title)}`;
        if (!imageByKey.has(key)) imageByKey.set(key, it.imageUrl);
      }
    }
    return fromGemini.map((it) =>
      it.imageUrl
        ? it
        : {
            ...it,
            imageUrl: imageByKey.get(
              `${normKey(it.artist || "")}::${normKey(it.title)}`,
            ),
          },
    );
  }

  return freeItems;
}

/** ジャンル別の無料APIを試し、ダメならWikidataへ（作品名だけで検索） */
async function freeApiItemsByTitle(
  title: string,
  genre: Genre,
): Promise<SuggestItem[]> {
  let items: SuggestItem[] = [];
  try {
    if (genre === "book") items = await viaBooksByTitle(title);
    else if (genre === "music") items = await viaMusicBrainzByTitle(title);
    else if (genre === "anime") items = await viaAniListByTitle(title);
  } catch {
    items = [];
  }

  if (items.length === 0) {
    try {
      items = await viaWikidataByTitle(title);
    } catch {
      items = [];
    }
  }
  return items;
}

async function viaGeminiByTitle(
  title: string,
  genre: Genre,
): Promise<SuggestItem[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  try {
    const prompt = `「${title}」に一致する実在の${GENRE_WORK_NOUN[genre]}を、作家名（著者・監督・アーティストなど）とともに日本語でJSONだけ返してください。

厳守:
- 独立した作品タイトルのみが対象。登場人物名やシーン名との混同に注意
- 同名の作品が複数の作家に存在する場合は、それぞれ別の候補として含める
- 実在が確実なもののみ最大6件

{"items":[{"title":"作品タイトル","artist":"作家名","note":"発表年など一言（不明なら省略）"}]}`;
    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("") || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as { items?: SuggestItem[] };
    return dedupe(
      (parsed.items || []).filter(
        (i) =>
          typeof i?.title === "string" &&
          typeof i?.artist === "string" &&
          i.artist,
      ),
    );
  } catch {
    return [];
  }
}

async function viaBooksByTitle(title: string): Promise<SuggestItem[]> {
  const items: SuggestItem[] = [];

  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:"${title}"`)}&maxResults=10&printType=books`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const v of data?.items || []) {
        const t = v?.volumeInfo?.title;
        const authors = v?.volumeInfo?.authors;
        const artistName = Array.isArray(authors)
          ? authors.join("・")
          : undefined;
        const year = (v?.volumeInfo?.publishedDate || "").slice(0, 4);
        const thumb =
          v?.volumeInfo?.imageLinks?.thumbnail ||
          v?.volumeInfo?.imageLinks?.smallThumbnail;
        if (t && artistName) {
          items.push({
            title: t,
            artist: artistName,
            note: year || undefined,
            imageUrl: thumb
              ? String(thumb).replace("http://", "https://")
              : undefined,
          });
        }
      }
    }
  } catch {
    // try next
  }

  if (items.length < 5) {
    try {
      const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=10&fields=title,author_name,first_publish_year,cover_i`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        for (const d of data?.docs || []) {
          const artistName = Array.isArray(d?.author_name)
            ? d.author_name.join("・")
            : undefined;
          if (d?.title && artistName) {
            items.push({
              title: d.title,
              artist: artistName,
              note: d.first_publish_year
                ? String(d.first_publish_year)
                : undefined,
              imageUrl:
                typeof d.cover_i === "number"
                  ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`
                  : undefined,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return dedupe(items);
}

async function viaMusicBrainzByTitle(title: string): Promise<SuggestItem[]> {
  const headers = {
    "User-Agent":
      "LoveArchive/0.1 (https://github.com/cotachi527-create/lovearchive)",
    Accept: "application/json",
  };
  const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(`releasegroup:"${title}"`)}&fmt=json&limit=10`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  const items: SuggestItem[] = [];
  for (const rg of data?.["release-groups"] || []) {
    const artistName = Array.isArray(rg?.["artist-credit"])
      ? rg["artist-credit"]
          .map((ac: { name?: string }) => ac.name)
          .filter(Boolean)
          .join("・")
      : undefined;
    if (rg?.title && artistName) {
      const year = (rg["first-release-date"] || "").slice(0, 4);
      items.push({
        title: rg.title,
        artist: artistName,
        note: year || undefined,
        imageUrl: rg.id
          ? `https://coverartarchive.org/release-group/${rg.id}/front-250`
          : undefined,
      });
    }
  }
  return dedupe(items);
}

async function viaAniListByTitle(title: string): Promise<SuggestItem[]> {
  const query = `query ($search: String) {
  Page(perPage: 8) {
    media(search: $search) {
      title { native romaji }
      coverImage { medium }
      startDate { year }
      staff(sort: RELEVANCE, perPage: 1) {
        edges { node { name { full native } } }
      }
    }
  }
}`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { search: title } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const nodes = data?.data?.Page?.media || [];
  const items: SuggestItem[] = [];
  for (const n of nodes) {
    const t = n?.title?.native || n?.title?.romaji;
    const artistName =
      n?.staff?.edges?.[0]?.node?.name?.full ||
      n?.staff?.edges?.[0]?.node?.name?.native;
    if (t && artistName) {
      items.push({
        title: t,
        artist: artistName,
        note: n?.startDate?.year ? String(n.startDate.year) : undefined,
        imageUrl: n?.coverImage?.medium || undefined,
      });
    }
  }
  return dedupe(items);
}

async function viaWikidataByTitle(title: string): Promise<SuggestItem[]> {
  // 1) 作品名でエンティティ候補を検索
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(title)}&language=ja&uselang=ja&format=json&origin=*&limit=6`;
  const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json();
  const qids = ((searchData?.search || []) as Array<{ id?: string }>)
    .map((s) => s.id)
    .filter((id): id is string => Boolean(id));
  if (qids.length === 0) return [];

  // 2) それぞれの候補の作家（著者・監督・制作者など）と画像をまとめて取得
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const sparql = `SELECT ?item ?itemLabel ?creatorLabel (SAMPLE(?img) AS ?image) WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P50|wdt:P57|wdt:P170|wdt:P86|wdt:P110|wdt:P178 ?creator .
  OPTIONAL { ?item wdt:P18 ?img }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
} GROUP BY ?item ?itemLabel ?creatorLabel LIMIT 12`;
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "LoveArchive/0.1 (https://github.com/cotachi527-create/lovearchive)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const items: SuggestItem[] = [];
  for (const row of data?.results?.bindings || []) {
    const itemLabel = row?.itemLabel?.value as string | undefined;
    const creatorLabel = row?.creatorLabel?.value as string | undefined;
    const img = row?.image?.value as string | undefined;
    if (
      itemLabel &&
      creatorLabel &&
      !/^Q\d+$/.test(itemLabel) &&
      !/^Q\d+$/.test(creatorLabel)
    ) {
      items.push({
        title: itemLabel,
        artist: creatorLabel,
        imageUrl: img
          ? `${img.replace("http://", "https://")}?width=240`
          : undefined,
      });
    }
  }
  return dedupe(items);
}

/** 作家名＋作品名から画像候補を集める */
async function findWorkImages(
  artist: string,
  title: string,
  genre: Genre,
): Promise<ImageCandidate[]> {
  const out: ImageCandidate[] = [];
  try {
    if (genre === "book") out.push(...(await bookWorkImages(artist, title)));
    else if (genre === "anime") out.push(...(await aniListWorkImages(title)));
    else if (genre === "music")
      out.push(...(await musicWorkImages(artist, title)));
  } catch {
    // try next
  }
  try {
    out.push(...(await wikipediaWorkImages(artist, title)));
  } catch {
    // ignore
  }
  return out;
}

async function bookWorkImages(
  artist: string,
  title: string,
): Promise<ImageCandidate[]> {
  const out: ImageCandidate[] = [];
  try {
    const q = `intitle:"${title}" inauthor:"${artist}"`;
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8&printType=books`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const v of data?.items || []) {
        const thumb =
          v?.volumeInfo?.imageLinks?.thumbnail ||
          v?.volumeInfo?.imageLinks?.smallThumbnail;
        if (thumb) {
          out.push({
            url: String(thumb).replace("http://", "https://"),
            note: "Google Books",
          });
        }
      }
    }
  } catch {
    // try next
  }
  try {
    const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(artist)}&limit=6&fields=cover_i`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const d of data?.docs || []) {
        if (typeof d?.cover_i === "number") {
          out.push({
            url: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
            note: "Open Library",
          });
        }
      }
    }
  } catch {
    // ignore
  }
  return out;
}

async function aniListWorkImages(title: string): Promise<ImageCandidate[]> {
  const query = `query ($search: String) {
  Page(perPage: 6) {
    media(search: $search) {
      title { native romaji }
      coverImage { large }
      bannerImage
    }
  }
}`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { search: title } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const out: ImageCandidate[] = [];
  for (const m of data?.data?.Page?.media || []) {
    const name = m?.title?.native || m?.title?.romaji || "";
    if (m?.coverImage?.large) {
      out.push({ url: m.coverImage.large, note: name });
    }
    if (m?.bannerImage) {
      out.push({ url: m.bannerImage, note: name });
    }
  }
  return out;
}

async function musicWorkImages(
  artist: string,
  title: string,
): Promise<ImageCandidate[]> {
  const headers = {
    "User-Agent":
      "LoveArchive/0.1 (https://github.com/cotachi527-create/lovearchive)",
    Accept: "application/json",
  };
  const query = `artist:"${artist}" AND releasegroup:"${title}"`;
  const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=6`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  const out: ImageCandidate[] = [];
  for (const rg of data?.["release-groups"] || []) {
    if (rg?.id) {
      out.push({
        url: `https://coverartarchive.org/release-group/${rg.id}/front-250`,
        note: rg.title || undefined,
      });
    }
  }
  return out;
}

async function wikipediaWorkImages(
  artist: string,
  title: string,
): Promise<ImageCandidate[]> {
  const q = encodeURIComponent(`${artist} ${title}`);
  const searchUrl = `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=3&format=json&origin=*`;
  const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json();
  const pageTitles = (searchData?.query?.search || [])
    .map((s: { title?: string }) => s.title)
    .filter(Boolean) as string[];
  if (pageTitles.length === 0) return [];

  const url = `https://ja.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitles.join("|"))}&prop=pageimages&pithumbsize=600&format=json&origin=*`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  const out: ImageCandidate[] = [];
  for (const page of Object.values(data?.query?.pages || {}) as Array<{
    title?: string;
    thumbnail?: { source?: string };
  }>) {
    if (page?.thumbnail?.source) {
      out.push({
        url: page.thumbnail.source,
        note: page.title ? `Wikipedia「${page.title}」` : "Wikipedia",
      });
    }
  }
  return out;
}

async function viaGemini(artist: string, genre: Genre): Promise<SuggestItem[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  try {
    const prompt = `「${artist}」が手がけた${GENRE_WORK_NOUN[genre]}を、日本語でJSONだけ返してください。

厳守:
- 独立した作品タイトルのみ。登場人物名・キャラクター名・シーン名・章タイトルは含めない
- 実在が確実なものだけ、代表的な順に最大8件
- 同じ作品を重複させない

{"items":[{"title":"作品タイトル","note":"発表年など一言（不明なら省略）"}]}`;
    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("") || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as { items?: SuggestItem[] };
    return dedupe(
      (parsed.items || []).filter((i) => typeof i?.title === "string"),
    );
  } catch {
    return [];
  }
}

async function viaBooks(artist: string): Promise<SuggestItem[]> {
  const items: SuggestItem[] = [];

  // Google Books（日本語書籍に強い）
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`inauthor:"${artist}"`)}&maxResults=20&printType=books`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const v of data?.items || []) {
        const title = v?.volumeInfo?.title;
        const year = (v?.volumeInfo?.publishedDate || "").slice(0, 4);
        const thumb =
          v?.volumeInfo?.imageLinks?.thumbnail ||
          v?.volumeInfo?.imageLinks?.smallThumbnail;
        if (title) {
          items.push({
            title,
            note: year || undefined,
            imageUrl: thumb
              ? String(thumb).replace("http://", "https://")
              : undefined,
          });
        }
      }
    }
  } catch {
    // try next
  }

  // Open Library で補完
  if (items.length < 5) {
    try {
      const url = `https://openlibrary.org/search.json?author=${encodeURIComponent(artist)}&limit=20&fields=title,first_publish_year,cover_i`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        for (const d of data?.docs || []) {
          if (d?.title) {
            items.push({
              title: d.title,
              note: d.first_publish_year ? String(d.first_publish_year) : undefined,
              imageUrl:
                typeof d.cover_i === "number"
                  ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`
                  : undefined,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return dedupe(items);
}

async function viaMusicBrainz(artist: string): Promise<SuggestItem[]> {
  const headers = {
    "User-Agent":
      "LoveArchive/0.1 (https://github.com/cotachi527-create/lovearchive)",
    Accept: "application/json",
  };
  const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${artist}"`)}&fmt=json&limit=1`;
  const searchRes = await fetch(searchUrl, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json();
  const mbid = searchData?.artists?.[0]?.id;
  if (!mbid) return [];

  const rgUrl = `https://musicbrainz.org/ws/2/release-group?artist=${mbid}&type=album&fmt=json&limit=20`;
  const rgRes = await fetch(rgUrl, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!rgRes.ok) return [];
  const rgData = await rgRes.json();
  const items: SuggestItem[] = [];
  for (const rg of rgData?.["release-groups"] || []) {
    if (rg?.title) {
      const year = (rg["first-release-date"] || "").slice(0, 4);
      items.push({
        title: rg.title,
        note: year || undefined,
        // Cover Art Archive のジャケット（存在しない場合はクライアント側で非表示）
        imageUrl: rg.id
          ? `https://coverartarchive.org/release-group/${rg.id}/front-250`
          : undefined,
      });
    }
  }
  return dedupe(items);
}

async function viaAniList(artist: string): Promise<SuggestItem[]> {
  const query = `query ($search: String) {
  Staff(search: $search) {
    staffMedia(perPage: 12, sort: POPULARITY_DESC) {
      nodes { title { native romaji } startDate { year } coverImage { medium } }
    }
  }
}`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { search: artist } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const nodes = data?.data?.Staff?.staffMedia?.nodes || [];
  const items: SuggestItem[] = [];
  for (const n of nodes) {
    const title = n?.title?.native || n?.title?.romaji;
    if (title) {
      items.push({
        title,
        note: n?.startDate?.year ? String(n.startDate.year) : undefined,
        imageUrl: n?.coverImage?.medium || undefined,
      });
    }
  }
  return dedupe(items);
}

async function viaWikidata(artist: string): Promise<SuggestItem[]> {
  // 1) 名前からエンティティを特定
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(artist)}&language=ja&uselang=ja&format=json&origin=*&limit=1`;
  const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json();
  const qid = searchData?.search?.[0]?.id as string | undefined;
  if (!qid) return [];

  // 2) 代表作(P800) と、作者・監督・制作者としての作品を取得
  const sparql = `SELECT DISTINCT ?workLabel (SAMPLE(?img) AS ?image) WHERE {
  { wd:${qid} wdt:P800 ?work }
  UNION
  { ?work wdt:P50|wdt:P57|wdt:P170|wdt:P86|wdt:P110|wdt:P178 wd:${qid} }
  OPTIONAL { ?work wdt:P18 ?img }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
} GROUP BY ?workLabel LIMIT 20`;
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "LoveArchive/0.1 (https://github.com/cotachi527-create/lovearchive)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const items: SuggestItem[] = [];
  for (const row of data?.results?.bindings || []) {
    const label = row?.workLabel?.value as string | undefined;
    const img = row?.image?.value as string | undefined;
    // ja/en ラベルがない項目は "Q12345" のまま返るので除外
    if (label && !/^Q\d+$/.test(label)) {
      items.push({
        title: label,
        imageUrl: img
          ? `${img.replace("http://", "https://")}?width=240`
          : undefined,
      });
    }
  }
  return dedupe(items);
}
