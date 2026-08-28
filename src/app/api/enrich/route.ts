import { NextRequest, NextResponse } from "next/server";
import { Genre, GENRE_KEYS } from "@/lib/types";

export const maxDuration = 60;

/** 実行時間の上限に届く前に、取れたところまでで必ず返すための時間予算 */
const IMAGE_BUDGET_MS = 24_000;
const TEXT_TIMEOUT_MS = 30_000;

type ImageResult = {
  imageUrl: string | null;
  imageCredit: string | null;
  imageSource: string | null;
};

type EnrichBody = {
  artist: string;
  title: string;
  genre?: Genre;
  /** 直接の画像URL（.jpg など） */
  imageUrl?: string | null;
  /** 公式HP（スクリーンショット用） */
  officialUrl?: string | null;
  /** true のとき登録URLを無視して自動取得のみ */
  forceAuto?: boolean;
  /** すでに使った画像ソース（他の画像切替用） */
  excludeSources?: string[];
  /** すでに表示した画像URL */
  excludeUrls?: string[];
};

export async function POST(req: NextRequest) {
  const body = (await req.json()) as EnrichBody;
  const artist = (body.artist || "").trim();
  const title = (body.title || "").trim();
  const genre: Genre = GENRE_KEYS.includes(body.genre as Genre)
    ? (body.genre as Genre)
    : "art";
  const userImageUrl = (body.imageUrl || "").trim() || null;
  const userOfficialUrl = (body.officialUrl || "").trim() || null;
  const forceAuto = Boolean(body.forceAuto);
  const excludeSources = Array.isArray(body.excludeSources)
    ? body.excludeSources.filter(Boolean)
    : [];
  const excludeUrls = Array.isArray(body.excludeUrls)
    ? body.excludeUrls.filter(Boolean)
    : [];

  // 作品名は任意（作家名だけの登録も許可）
  if (!artist) {
    return NextResponse.json({ error: "artist が必要です" }, { status: 400 });
  }

  let image = emptyImage();

  // 1) 登録した画像URL（直接画像）
  if (userImageUrl && !forceAuto && !excludeSources.includes("registered")) {
    image = await resolveDirectImageUrl(userImageUrl);
    if (image.imageUrl && excludeUrls.includes(image.imageUrl)) {
      image = emptyImage();
    }
  }

  // 2) 登録した公式HPのスクリーンショット
  if (
    !image.imageUrl &&
    userOfficialUrl &&
    !forceAuto &&
    !excludeSources.includes("official")
  ) {
    image = await resolveOfficialPageImage(userOfficialUrl);
    if (image.imageUrl && excludeUrls.includes(image.imageUrl)) {
      image = emptyImage();
    }
  }

  // 3) 自動取得（公式候補スクショ → ジャンル別 → Wikipedia）
  // 画像と略歴は互いに独立なので並列で取る（直列だと実行時間の上限に届く）
  const [autoImage, textInfo] = await Promise.all([
    image.imageUrl
      ? Promise.resolve(image)
      : resolveImage(
          genre,
          artist,
          title,
          excludeSources,
          excludeUrls,
          forceAuto ? null : userOfficialUrl,
        ),
    resolveText(artist, title, userOfficialUrl),
  ]);
  image = autoImage;

  return NextResponse.json({
    imageUrl: image.imageUrl,
    imageCredit: image.imageCredit,
    imageSource: image.imageSource,
    bio: textInfo.bio,
    latest: textInfo.latest,
    sourceUrls: textInfo.sourceUrls,
  });
}

/** Gemini のエラー本文から、原因が分かる最小限だけ取り出す */
async function describeGeminiError(res: Response) {
  try {
    const body = (await res.json()) as {
      error?: {
        message?: string;
        status?: string;
        details?: { quotaId?: string; violations?: { quotaId?: string }[] }[];
      };
    };
    const quotaId =
      body.error?.details
        ?.flatMap((d) => [d.quotaId, ...(d.violations || []).map((v) => v.quotaId)])
        .find(Boolean) || "-";
    return `${body.error?.status || "-"} / quota=${quotaId} / ${(body.error?.message || "").slice(0, 120)}`;
  } catch {
    return "(本文を解析できませんでした)";
  }
}

async function resolveText(
  artist: string,
  title: string,
  officialUrl?: string | null,
) {
  // 作品名は任意。未入力なら作家名だけを対象にする
  const query = `${artist} ${title}`.trim();
  const subject = title ? `${artist} の作品『${title}』` : artist;
  const latestSubject = title ? `『${title}』` : artist;

  const sourceUrls = [
    ...(officialUrl
      ? [{ label: "公式サイト", url: officialUrl }]
      : []),
    {
      label: "Wikipedia検索",
      url: `https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`,
    },
    {
      label: "Web検索",
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    },
  ];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      bio: `${subject}。略歴の自動要約には GEMINI_API_KEY の設定が必要です。`,
      latest: `${latestSubject}の最新情報は下のリンクから確認できます。`,
      sourceUrls,
    };
  }

  try {
    const prompt = `あなたはアート・エンタメのキュレーターです。次の${title ? "作品" : "作家"}について、日本語で簡潔にJSONだけ返してください。説明文は不要です。

作家名: ${artist}
${title ? `作品名: ${title}\n` : ""}
返すべきJSONの形:
{
  "bio": "作家の略歴を2〜4文",
  "latest": "展覧会・書籍・ドキュメンタリー・近況など最新情報を2〜3文。不明なら「公開情報では確認できませんでした」と書く"
}`;

    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 },
      }),
      signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
    });

    if (!res.ok) {
      // 無言で定型文に落ちると原因が追えないので、失敗理由は必ず残す
      console.error(
        "[enrich] gemini text failed",
        res.status,
        await describeGeminiError(res),
      );
      return {
        bio: `${subject}について。`,
        latest: "最新情報の取得に失敗しました。リンクから確認してください。",
        sourceUrls,
      };
    }

    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("") || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        bio: `${subject}について。`,
        latest: "最新情報はリンクから確認してください。",
        sourceUrls,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      bio?: string;
      latest?: string;
    };

    return {
      bio: parsed.bio || `${subject}について。`,
      latest:
        parsed.latest ||
        "最新情報は、公式サイトや関連情報で確認してください。",
      sourceUrls,
    };
  } catch {
    return {
      bio: `${subject}について。`,
      latest: "最新情報はリンクから確認してください。",
      sourceUrls,
    };
  }
}

async function resolveDirectImageUrl(url: string): Promise<ImageResult> {
  if (url.startsWith("data:image/")) {
    return {
      imageUrl: url,
      imageCredit: "手動で追加した画像",
      imageSource: "registered",
    };
  }
  if (!isSafePublicUrl(url)) return emptyImage();

  if (/\.(avif|bmp|gif|jpe?g|png|webp|svg)(\?|#|$)/i.test(url)) {
    return {
      imageUrl: url,
      imageCredit: "登録した画像URL",
      imageSource: "registered",
    };
  }

  // 拡張子なしでも画像を返すカバーAPI
  if (/coverartarchive\.org|books\.google\./i.test(url)) {
    return {
      imageUrl: url,
      imageCredit: "登録した画像URL",
      imageSource: "registered",
    };
  }

  // 画像URL欄にページURLが入った場合のフォールバック
  return resolveOfficialPageImage(url);
}

async function resolveOfficialPageImage(url: string): Promise<ImageResult> {
  if (!isSafePublicUrl(url)) return emptyImage();

  const shot = await fetchPageScreenshot(url);
  if (shot.imageUrl) {
    return {
      ...shot,
      imageCredit: "公式サイトのスクリーンショット",
      imageSource: "official",
    };
  }

  // 予備: og:image
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "LoveArchive/0.1 (+https://github.com/cotachi527-create/lovearchive)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const html = await res.text();
      const og =
        html.match(
          /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
        ) ||
        html.match(
          /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
        ) ||
        html.match(
          /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
        ) ||
        html.match(
          /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
        );

      if (og?.[1]) {
        const absolute = toAbsoluteUrl(url, og[1].trim());
        if (absolute) {
          return {
            imageUrl: absolute,
            imageCredit: "公式ページのプレビュー画像（og:image）より",
            imageSource: "official",
          };
        }
      }
    }
  } catch {
    // ignore
  }

  return emptyImage();
}

function isSafePublicUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "0.0.0.0"
    ) {
      return false;
    }
    if (
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(
        host,
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function toAbsoluteUrl(base: string, maybeRelative: string) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

async function fetchPageScreenshot(pageUrl: string): Promise<ImageResult> {
  if (!isSafePublicUrl(pageUrl)) return emptyImage();

  try {
    const api = `https://api.microlink.io/?url=${encodeURIComponent(pageUrl)}&screenshot=true&meta=false&viewport.width=1280&viewport.height=800`;
    const res = await fetch(api, { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const data = await res.json();
      const shotUrl = data?.data?.screenshot?.url as string | undefined;
      if (data?.status === "success" && shotUrl) {
        return {
          imageUrl: shotUrl,
          imageCredit: "公式サイトのスクリーンショット",
          imageSource: "screenshot",
        };
      }
    }
  } catch {
    // try next
  }

  try {
    const thum = `https://image.thum.io/get/width/1200/crop/800/noanimate/${pageUrl}`;
    const head = await fetch(thum, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (head.ok) {
      return {
        imageUrl: thum,
        imageCredit: "公式サイトのスクリーンショット",
        imageSource: "screenshot",
      };
    }
  } catch {
    // ignore
  }

  return emptyImage();
}

async function findOfficialPageUrl(
  artist: string,
  title: string,
  genre: Genre,
) {
  const fromGemini = await findOfficialViaGemini(artist, title, genre);
  if (fromGemini) return fromGemini;

  const fromWikiLinks = await findOfficialViaWikipediaLinks(artist, title);
  if (fromWikiLinks) return fromWikiLinks;

  return null;
}

async function findOfficialViaGemini(
  artist: string,
  title: string,
  genre: Genre,
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const prompt = `次の${title ? "作品" : "作家"}の「公式サイト」または出版社・公式レーベル・制作委員会の公式紹介ページのURLを1つだけJSONで返してください。

作家名: ${artist}
${title ? `作品名: ${title}\n` : ""}ジャンル: ${genre}

厳守:
- Wikipedia・Amazon・楽天・Yahoo・Google・SNS（X/Twitter/Instagram/Facebook/YouTube）・個人ブログは不可
- 公式ドメインや出版社公式の作品ページを最優先
- 不明な場合は {"officialUrl":null}

{"officialUrl":"https://..."}`;
    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("") || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { officialUrl?: string | null };
    const official = (parsed.officialUrl || "").trim();
    if (official && isSafePublicUrl(official) && isLikelyOfficialUrl(official)) {
      return official;
    }
  } catch {
    // ignore
  }
  return null;
}

async function findOfficialViaWikipediaLinks(artist: string, title: string) {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const searchUrl = `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&origin=*`;
    const searchRes = await fetch(searchUrl, {
      signal: AbortSignal.timeout(8000),
    });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const pageTitle = searchData?.query?.search?.[0]?.title as
      | string
      | undefined;
    if (!pageTitle) return null;

    const linksUrl = `https://ja.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=extlinks&ellimit=80&format=json&origin=*`;
    const linksRes = await fetch(linksUrl, {
      signal: AbortSignal.timeout(8000),
    });
    if (!linksRes.ok) return null;
    const linksData = await linksRes.json();
    const pages = linksData?.query?.pages || {};
    const page = Object.values(pages)[0] as {
      extlinks?: Array<{ "*"?: string }>;
    };
    const links = (page?.extlinks || [])
      .map((l) => l["*"] || "")
      .filter((u) => u.startsWith("http"));

    const scored = links
      .filter((u) => isSafePublicUrl(u) && isLikelyOfficialUrl(u))
      .map((u) => ({ url: u, score: scoreOfficialCandidate(u, artist, title) }))
      .sort((a, b) => b.score - a.score);

    return scored[0]?.score > 0 ? scored[0].url : null;
  } catch {
    return null;
  }
}

function isLikelyOfficialUrl(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const blocked = [
      "wikipedia.org",
      "wikimedia.org",
      "amazon.",
      "rakuten.",
      "yahoo.",
      "google.",
      "bing.",
      "facebook.com",
      "instagram.com",
      "twitter.com",
      "x.com",
      "youtube.com",
      "youtu.be",
      "tiktok.com",
      "note.com",
      "hatena.",
      "blogspot.",
      "medium.com",
      "reddit.com",
      "imdb.com",
      "myanimelist.net",
      "anilist.co",
      "goodreads.com",
      "openlibrary.org",
    ];
    return !blocked.some((b) => host.includes(b));
  } catch {
    return false;
  }
}

function scoreOfficialCandidate(url: string, artist: string, title: string) {
  let score = 1;
  const lower = url.toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (/公式|official|官网/.test(lower)) score += 8;
  if (host.includes("official")) score += 6;
  if (/\.(jp|com|net|org)$/.test(host)) score += 1;

  const tokens = `${artist} ${title}`
    .toLowerCase()
    .split(/[\s　・/／\-_|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  for (const t of tokens) {
    if (lower.includes(encodeURIComponent(t).toLowerCase()) || lower.includes(t)) {
      score += 2;
    }
  }

  // 出版社・レーベルっぽいドメインを少し優遇
  if (
    /(kodansha|shueisha|shogakukan|kadokawa|square-enix|bandainamco|toho|warner|disney|netflix|sony|universal)/.test(
      host,
    )
  ) {
    score += 4;
  }

  return score;
}

async function resolveImage(
  genre: Genre,
  artist: string,
  title: string,
  excludeSources: string[] = [],
  excludeUrls: string[] = [],
  preferredOfficialUrl: string | null = null,
): Promise<ImageResult> {
  const attempts: Array<{
    source: string;
    run: () => Promise<ImageResult>;
  }> = [];

  // 作品名がないと成立しない検索は、作品名がある場合だけ試す
  if (title) {
    if (genre === "book") {
      attempts.push({
        source: "openlibrary",
        run: () => fetchOpenLibraryCover(artist, title),
      });
      attempts.push({
        source: "googlebooks",
        run: () => fetchGoogleBooksCover(artist, title),
      });
    }
    if (genre === "movie") {
      attempts.push({
        source: "tmdb",
        run: () => fetchTmdbPoster(artist, title),
      });
    }
    if (genre === "anime") {
      attempts.push({
        source: "jikan",
        run: () => fetchJikanImage(title, artist),
      });
    }
    if (genre === "music") {
      attempts.push({
        source: "coverart",
        run: () => fetchCoverArtArchive(artist, title),
      });
    }
    attempts.push({
      source: "wikipedia",
      run: () => fetchWikipediaImage(artist, title),
    });
  }

  attempts.push({
    source: "wikipedia-artist",
    run: () => fetchWikipediaImage(artist, ""),
  });

  // 公式サイトのスクリーンショットは最後の手段（Gemini呼び出し＋外部サービスで重いため）
  attempts.push({
    source: "screenshot",
    run: async () => {
      const page =
        (preferredOfficialUrl && isSafePublicUrl(preferredOfficialUrl)
          ? preferredOfficialUrl
          : null) || (await findOfficialPageUrl(artist, title, genre));
      if (!page) return emptyImage();
      const shot = await fetchPageScreenshot(page);
      if (!shot.imageUrl) return emptyImage();
      return {
        ...shot,
        imageCredit: "公式サイトのスクリーンショット",
        imageSource: "screenshot",
      };
    },
  });

  const deadline = Date.now() + IMAGE_BUDGET_MS;
  for (const attempt of attempts) {
    if (excludeSources.includes(attempt.source)) continue;
    // 予算切れなら残りは諦めて、画像なしで返す（全体のタイムアウトを防ぐ）
    if (Date.now() > deadline) break;
    try {
      const result = await attempt.run();
      if (
        result.imageUrl &&
        !excludeUrls.includes(result.imageUrl) &&
        !excludeSources.includes(result.imageSource || attempt.source)
      ) {
        return {
          ...result,
          imageSource: result.imageSource || attempt.source,
        };
      }
    } catch {
      // try next
    }
  }

  return emptyImage();
}

async function fetchOpenLibraryCover(artist: string, title: string): Promise<ImageResult> {
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(artist)}&limit=5`;
  const res = await fetch(url);
  if (!res.ok) return emptyImage();
  const data = await res.json();
  const doc = (data?.docs || []).find(
    (d: { cover_i?: number }) => typeof d.cover_i === "number",
  );
  if (!doc?.cover_i) return emptyImage();
  return {
    imageUrl: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
    imageCredit: "画像: Open Library",
    imageSource: "openlibrary",
  };
}

async function fetchGoogleBooksCover(artist: string, title: string): Promise<ImageResult> {
  const q = `intitle:${title}+inauthor:${artist}`;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=3`;
  const res = await fetch(url);
  if (!res.ok) return emptyImage();
  const data = await res.json();
  const items = data?.items || [];
  for (const item of items) {
    const links = item?.volumeInfo?.imageLinks;
    const raw =
      links?.large ||
      links?.medium ||
      links?.thumbnail ||
      links?.smallThumbnail;
    if (raw) {
      return {
        imageUrl: String(raw).replace("http://", "https://"),
        imageCredit: "画像: Google Books",
        imageSource: "googlebooks",
      };
    }
  }
  return emptyImage();
}

async function fetchTmdbPoster(artist: string, title: string): Promise<ImageResult> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return emptyImage();

  const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${key}&query=${encodeURIComponent(title)}&language=ja-JP`;
  const res = await fetch(searchUrl);
  if (!res.ok) return emptyImage();
  const data = await res.json();
  const results = data?.results || [];
  const withPoster =
    results.find(
      (r: { poster_path?: string; overview?: string }) =>
        r.poster_path &&
        artist &&
        String(r.overview || "").includes(artist),
    ) || results.find((r: { poster_path?: string }) => r.poster_path);

  if (!withPoster?.poster_path) return emptyImage();
  return {
    imageUrl: `https://image.tmdb.org/t/p/w500${withPoster.poster_path}`,
    imageCredit: "画像: TMDB",
    imageSource: "tmdb",
  };
}

async function fetchJikanImage(title: string, artist: string): Promise<ImageResult> {
  const q = encodeURIComponent(title || artist);
  const url = `https://api.jikan.moe/v4/anime?q=${q}&limit=5`;
  const res = await fetch(url);
  if (!res.ok) return emptyImage();
  const data = await res.json();
  const list = data?.data || [];
  const hit =
    list.find(
      (a: {
        images?: { jpg?: { large_image_url?: string; image_url?: string } };
      }) => a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
    ) || list[0];
  const imageUrl =
    hit?.images?.jpg?.large_image_url || hit?.images?.jpg?.image_url || null;
  if (!imageUrl) return emptyImage();
  return {
    imageUrl,
    imageCredit: "画像: Jikan / MyAnimeList",
    imageSource: "jikan",
  };
}

async function fetchCoverArtArchive(artist: string, title: string): Promise<ImageResult> {
  const query = `artist:"${artist}" AND release:"${title}"`;
  const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "LoveArchive/0.1 (https://github.com/cotachi527-create/lovearchive)",
      Accept: "application/json",
    },
  });
  if (!res.ok) return emptyImage();
  const data = await res.json();
  const releases = data?.releases || [];
  for (const release of releases) {
    const mbid = release?.id;
    if (!mbid) continue;
    const coverUrl = `https://coverartarchive.org/release/${mbid}/front-500`;
    const head = await fetch(coverUrl, { method: "HEAD", redirect: "follow" });
    if (head.ok) {
      return {
        imageUrl: coverUrl,
        imageCredit: "画像: Cover Art Archive / MusicBrainz",
        imageSource: "coverart",
      };
    }
  }
  return emptyImage();
}

async function fetchWikipediaImage(artist: string, title: string): Promise<ImageResult> {
  try {
    const q = [artist, title].filter(Boolean).join(" ");
    if (!q) return emptyImage();
    const searchUrl = `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&origin=*`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return emptyImage();
    const searchData = await searchRes.json();
    const pageTitle = searchData?.query?.search?.[0]?.title as
      | string
      | undefined;
    if (!pageTitle) return emptyImage();
    return pullPageImage(pageTitle, title ? "wikipedia" : "wikipedia-artist");
  } catch {
    return emptyImage();
  }
}

async function pullPageImage(
  pageTitle: string,
  imageSource: string,
): Promise<ImageResult> {
  const url = `https://ja.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=pageimages&pithumbsize=800&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return emptyImage();
  const data = await res.json();
  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0] as {
    thumbnail?: { source?: string };
  };
  const imageUrl = page?.thumbnail?.source || null;
  return {
    imageUrl,
    imageCredit: imageUrl ? `画像: Wikipedia「${pageTitle}」より` : null,
    imageSource: imageUrl ? imageSource : null,
  };
}

function emptyImage(): ImageResult {
  return {
    imageUrl: null,
    imageCredit: null,
    imageSource: null,
  };
}
