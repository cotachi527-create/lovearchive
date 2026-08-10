import { NextRequest, NextResponse } from "next/server";

type EnrichBody = {
  artist: string;
  title: string;
};

export async function POST(req: NextRequest) {
  const body = (await req.json()) as EnrichBody;
  const artist = (body.artist || "").trim();
  const title = (body.title || "").trim();

  if (!artist || !title) {
    return NextResponse.json(
      { error: "artist と title が必要です" },
      { status: 400 },
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(mockEnrich(artist, title));
  }

  try {
    const prompt = `あなたはアート・エンタメのキュレーターです。次の作品について、日本語で簡潔にJSONだけ返してください。説明文は不要です。

作家名: ${artist}
作品名: ${title}

返すべきJSONの形:
{
  "bio": "作家の略歴を2〜4文",
  "latest": "展覧会・書籍・ドキュメンタリー・近況など最新情報を2〜3文。不明なら「公開情報では確認できませんでした」と書く",
  "imageQuery": "代表ビジュアル検索用の短い英語クエリ",
  "sourceHints": ["調べるときのキーワード1", "キーワード2"]
}`;

    const model =
      process.env.GEMINI_MODEL || "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Gemini error", res.status, errText);
      return NextResponse.json(mockEnrich(artist, title));
    }

    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("") || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(mockEnrich(artist, title));
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      bio?: string;
      latest?: string;
      imageQuery?: string;
      sourceHints?: string[];
    };

    const wiki = await fetchWikipediaImage(artist, title);

    return NextResponse.json({
      imageUrl: wiki.imageUrl,
      imageCredit: wiki.imageCredit,
      bio: parsed.bio || `${artist} の作品『${title}』について。`,
      latest:
        parsed.latest ||
        "最新情報は、公式サイトや展覧会情報で確認してください。",
      sourceUrls: [
        {
          label: "Wikipedia検索",
          url: `https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(`${artist} ${title}`)}`,
        },
        {
          label: "Web検索",
          url: `https://www.google.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
        },
      ],
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(mockEnrich(artist, title));
  }
}

function mockEnrich(artist: string, title: string) {
  return {
    imageUrl: null,
    imageCredit: null,
    bio: `${artist} は、あなたのコレクションに登録された作家です。『${title}』は、そのなかで今日めぐってきた一枚。略歴の自動取得には GEMINI_API_KEY の設定が必要です（未設定でも文字カードで楽しめます）。`,
    latest: `『${title}』に関する展覧会・書籍・ドキュメンタリー情報は、下のリンクから探せます。APIキーを設定すると、ここに要約が表示されます。`,
    sourceUrls: [
      {
        label: "Wikipedia検索",
        url: `https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(`${artist} ${title}`)}`,
      },
      {
        label: "Web検索",
        url: `https://www.google.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
      },
    ],
  };
}

async function fetchWikipediaImage(artist: string, title: string) {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const searchUrl = `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&origin=*`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return { imageUrl: null, imageCredit: null };
    const searchData = await searchRes.json();
    const pageTitle = searchData?.query?.search?.[0]?.title as
      | string
      | undefined;
    if (!pageTitle) {
      // try artist only
      const aUrl = `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(artist)}&format=json&origin=*`;
      const aRes = await fetch(aUrl);
      const aData = await aRes.json();
      const aTitle = aData?.query?.search?.[0]?.title as string | undefined;
      if (!aTitle) return { imageUrl: null, imageCredit: null };
      return pullPageImage(aTitle);
    }
    return pullPageImage(pageTitle);
  } catch {
    return { imageUrl: null, imageCredit: null };
  }
}

async function pullPageImage(pageTitle: string) {
  const url = `https://ja.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=pageimages&pithumbsize=800&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return { imageUrl: null, imageCredit: null };
  const data = await res.json();
  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0] as {
    thumbnail?: { source?: string };
  };
  const imageUrl = page?.thumbnail?.source || null;
  return {
    imageUrl,
    imageCredit: imageUrl
      ? `画像: Wikipedia「${pageTitle}」より`
      : null,
  };
}
