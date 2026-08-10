# LoveArchive（ラブアカ）

自分の好きを思い出す（活用）する Web ツール。  
好きの棚を、毎日ひらく。

## できること

1. **コレクション登録** — 作家名と作品名だけ
2. **今日の一枚** — 中央ボタンでランダム表示（最近出していないものを優先）
3. **AI補完** — 画像・略歴・最新情報（展覧会・書籍など）
4. **FOR YOU** — Art / Game / 映画 / 書籍 / アニメ / 音楽（ライブ）を好み設定で表示
5. **メモ／タグ** — 一枚ごとに短い記録

## 起動

```bash
cd lovearchive
npm install
cp .env.example .env.local   # Windows: copy .env.example .env.local
# .env.local に GEMINI_API_KEY を入れる（無くてもデモ動作します）
npm run dev
```

ブラウザで http://localhost:3000 を開く。

## 補足

- データはこのブラウザの localStorage に保存（クラウドログインは次フェーズ）
- `GEMINI_API_KEY` 未設定時は文字カード＋デモ用フィードで動きます
- 画像は Wikipedia のサムネイルを優先して取得します
