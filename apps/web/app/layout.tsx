import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";

// Inter — display + body (variable, có subsets latin/vietnamese)
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "vietnamese"],
  display: "swap",
});

// Geist Mono — giữ cho hashtag / ID chunk / metadata kỹ thuật
const geistMono = Geist_Mono({
  variable: "--font-mono-geist",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Hỏi đáp Sổ tay sinh viên UTC — RAG",
  description:
    "Chat RAG với Sổ tay sinh viên K64 (UTC) — 23 tag, Ollama, hybrid BM25+vector",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="vi"
      className={`dark ${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-border focus:bg-card focus:px-3 focus:py-2 focus:text-sm"
        >
          Bỏ qua tới nội dung chính
        </a>
        {children}
      </body>
    </html>
  );
}
