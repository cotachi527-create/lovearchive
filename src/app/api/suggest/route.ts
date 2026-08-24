import { NextRequest, NextResponse } from "next/server";
import { Genre, GENRE_KEYS } from "@/lib/types";

export const maxDuration = 30;

type SuggestItem = { title: string; note?: string; imageUrl?: string };

type ImageCandidate = { url: string; note?: string };

type SuggestBody = {
  artist: string;
  /** 指定時は「この作品の画像候補」を返す */
  title?: string;
  genre?: Genre;
};

export async function POST(req: NextRequest) {
  const body = (await req.json()) as SuggestBody;
  const artist = (body.artist || "").trim();
  const genre: Genre = GENRE_KEYS.includes(body.genre as Genre)
    ? (body.genre as Genre)
    : "art";

  if (!artist) {
    return NextResponse.json({ error: "artist が必要です" }, { status: 400 });
  }

  // 作品名あり → その作品の画像候補を返すモード
  const title = (body.title || "").trim();
  if (title) {
    let images: ImageCandidate[] = [];
    try {
      images = await findWorkImages(artist, title, genre);
    } catch {
      images = [];
    }
    return NextResponse.json({ images: dedupeImages(images).slice(0, 12) });
  }

  // 1) Gemini（キーがあれば最優先。ジャンル問わず質が高い）
  const fromGemini = await viaGemini(artist, genre);
  if (fromGemini.length > 0) {
    return NextResponse.json({ items: fromGemini.slice(0, 12) });
  }

  // 2) ジャンル別の無料API
  let items: SuggestItem[] = [];
  try {
    if (genre === "book") items = await viaBooks(artist);
    else if (genre === "music") items = await viaMusicBrainz(artist);
    else if (genre === "anime") items = await viaAniList(artist);
  } catch {
    items = [];
  }

  // 3) Wikidata（汎用フォールバック）
  if (items.length === 0) {
    try {
      items = await viaWikidata(artist);
    } catch {
      items = [];
    }
  }

  return NextResponse.json({ items: dedupe(items).slice(0, 12) });
}

function dedupe(items: SuggestItem[]): SuggestItem[] {
  const seen = new Map<string, SuggestItem>();
  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...item, title: item.title.trim() });
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
    const prompt = `「${artist}」（ジャンル: ${genre}）の代表的な作品名を、日本語でJSONだけ返してください。実在が確実な作品のみ、有名順に最大10件。

{"items":[{"title":"作品名","note":"発表年など一言（不明なら省略）"}]}`;
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
