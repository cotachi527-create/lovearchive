import { NextRequest, NextResponse } from "next/server";
import { Genre } from "@/lib/types";

type FeedBody = {
  genres: Genre[];
  favoriteTags: Record<string, string[]>;
};

export async function POST(req: NextRequest) {
  const body = (await req.json()) as FeedBody;
  const genres = body.genres?.length
    ? body.genres
    : (["art", "game", "movie", "book", "anime", "music"] as Genre[]);
  const favoriteTags = body.favoriteTags || {};

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ items: mockFeed(genres, favoriteTags) });
  }

  try {
    const tagsText = genres
      .map((g) => {
        const tags = favoriteTags[g] || [];
        return `${g}: ${tags.length ? tags.join(", ") : "指定なし"}`;
      })
      .join("\n");

    const prompt = `あなたはカルチャー情報のキュレーターです。ユーザーの好みに合う「今知ると嬉しい」情報を、ジャンルごとに1〜2件、日本語のJSON配列だけで返してください。

有効ジャンルと好みタグ:
${tagsText}

返すべきJSON:
{
  "items": [
    {
      "genre": "art" | "game" | "movie" | "book" | "anime" | "music",
      "title": "短い見出し",
      "summary": "2文以内の要約",
      "searchQuery": "詳しい情報を探すための検索クエリ"
    }
  ]
}

ジャンルの目安:
- art: 展覧会・美術
- game: ゲーム
- movie: 映画
- book: 書籍（ビジネス書・文芸など）
- anime: アニメ
- music: 音楽・ライブ・ツアー情報

実在しそうな展覧会・作品・ニュースのトーンで。断定しすぎず、検索で確かめられる書き方にしてください。`;

    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7 },
      }),
    });

    if (!res.ok) {
      return NextResponse.json({ items: mockFeed(genres, favoriteTags) });
    }

    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("") || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ items: mockFeed(genres, favoriteTags) });
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      items?: {
        genre: Genre;
        title: string;
        summary: string;
        searchQuery?: string;
      }[];
    };

    const items = (parsed.items || [])
      .filter((i) => genres.includes(i.genre))
      .map((i, idx) => ({
        id: `ai-${i.genre}-${idx}`,
        genre: i.genre,
        title: i.title,
        summary: i.summary,
        url: `https://www.google.com/search?q=${encodeURIComponent(i.searchQuery || i.title)}`,
      }));

    if (items.length === 0) {
      return NextResponse.json({ items: mockFeed(genres, favoriteTags) });
    }

    return NextResponse.json({ items });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ items: mockFeed(genres, favoriteTags) });
  }
}

function mockFeed(
  genres: Genre[],
  favoriteTags: Record<string, string[]>,
) {
  const samples: Record<
    Genre,
    { title: string; summary: string; q: string }[]
  > = {
    art: [
      {
        title: "今週末みられる展覧会をチェック",
        summary:
          "好みの作家・作風に近い展示が近くで開いていないか、検索してみましょう。",
        q: "展覧会 おすすめ",
      },
      {
        title: "図録・アートブックの新刊動向",
        summary:
          "好きな作家名で新刊や図録が出ていないか眺めると、棚がまた豊かになります。",
        q: "アート 図録 新刊",
      },
    ],
    game: [
      {
        title: "気になる新作・アップデート情報",
        summary:
          "好みタグに近いジャンルの新作発表や大型アプデを拾ってみましょう。",
        q: "ゲーム 新作 情報",
      },
    ],
    movie: [
      {
        title: "劇場・配信の新着候補",
        summary:
          "好きな監督・俳優・雰囲気に合う作品が、劇場や配信に上がっていないか確認を。",
        q: "映画 公開情報",
      },
    ],
    book: [
      {
        title: "読みたい一冊の手がかり",
        summary:
          "好みのテーマや著者に近い新刊・話題書を探してみましょう。",
        q: "書籍 新刊 おすすめ",
      },
    ],
    anime: [
      {
        title: "今期・注目のアニメ情報",
        summary:
          "好きな作品・スタジオ・声優まわりの放送・配信・イベント情報をチェック。",
        q: "アニメ 放送 情報",
      },
    ],
    music: [
      {
        title: "ライブ・ツアー情報を探す",
        summary:
          "好きなアーティストの公演・チケット・配信ライブが出ていないか確認を。",
        q: "ライブ チケット 情報",
      },
    ],
  };

  const items = [];
  for (const g of genres) {
    const tag = (favoriteTags[g] || [])[0];
    for (const s of samples[g].slice(0, 2)) {
      const q = tag ? `${tag} ${s.q}` : s.q;
      items.push({
        id: `mock-${g}-${s.title}`,
        genre: g,
        title: tag ? `${tag} × ${s.title}` : s.title,
        summary:
          s.summary +
          (process.env.GEMINI_API_KEY
            ? ""
            : "（デモ表示。GEMINI_API_KEY で好みに寄せた要約にできます）"),
        url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
      });
    }
  }
  return items;
}
