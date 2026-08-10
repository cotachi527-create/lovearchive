import type { Metadata } from "next";
import { Noto_Sans_JP } from "next/font/google";
import "./globals.css";

const noto = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
});

export const metadata: Metadata = {
  title: "LoveArchive（ラブアカ）",
  description:
    "自分の好きを思い出す（活用）する。好きの棚を、毎日ひらくWebツール。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className={`${noto.className} antialiased`}>{children}</body>
    </html>
  );
}
