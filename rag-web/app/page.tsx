"use client";

// app/page.tsx — Chat RAG Sổ tay sinh viên UTC
// Khách: chỉ chat. Admin: + panel tham số, preheat, reload, gán tag, quản lý tag.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ParamsPanel from "@/components/ParamsPanel";
import ChatMessage, { type ChatItem } from "@/components/ChatMessage";
import TagManager from "@/components/TagManager";
import {
  askStream,
  clearSession,
  fetchHealth,
  getSession,
  type Health,
  type RParams,
  type Session,
} from "@/lib/api";

const DEFAULT_PARAMS: RParams = {
  model: "qwen2.5:3b-instruct",
  temperature: 0.2,
  max_tokens: 280,
  topk: 1,
  rrf_k: 60,
  tag_boost: 1.5,
  margin_ask: 0.08,
  score_low: 0.3,
  keep_alive: "24h",
  use_llm: true,
};

const SUGGESTIONS = [
  "Điều kiện xét học bổng là gì?",
  "Quy trình kỷ luật sinh viên như thế nào?",
  "Làm sao để vay vốn sinh viên?",
  "Điều kiện ngoại ngữ đầu ra là gì?",
  "Đăng ký ký túc xá ở đâu?",
  "Thủ tục cấp thẻ sinh viên?",
];

let uid = 0;
const nextId = () => `m${++uid}`;

export default function Page() {
  const router = useRouter();
  const [session, setSessionState] = useState<Session | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [params, setParams] = useState<RParams>(DEFAULT_PARAMS);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isAdmin = session?.role === "admin";

  // ---- AuthGuard: chưa đăng nhập → /login ----
  useEffect(() => {
    // setTimeout 0: tránh set-state đồng bộ trong effect (react-hooks rule)
    const t = setTimeout(() => {
      const s = getSession();
      if (!s) {
        router.replace("/login");
        return;
      }
      setSessionState(s);
      setAuthChecked(true);
    }, 0);
    return () => clearTimeout(t);
  }, [router]);

  // ---- Health poll (5s) ----
  const pollHealth = useCallback(async () => {
    try {
      setHealth(await fetchHealth());
      setHealthError(null);
    } catch (e) {
      setHealthError(`Không kết nối được backend :8000 (${String(e)})`);
    }
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    // gọi trì hoãn để không set-state đồng bộ trong effect (react-hooks rule)
    const init = setTimeout(() => void pollHealth(), 0);
    const t = setInterval(() => void pollHealth(), 5000);
    return () => {
      clearTimeout(init);
      clearInterval(t);
    };
  }, [pollHealth, authChecked]);

  // ---- Auto scroll khi có token mới ----
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const updateItem = (id: string, patch: Partial<ChatItem>) =>
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  // ---- Gửi 1 câu hỏi (forceTag: tag user chọn thủ công khi mơ hồ) ----
  const send = useCallback(
    async (text: string, forceTag?: string | null) => {
      const q = text.trim();
      if (!q || busy) return;
      setInput("");
      setBusy(true);

      const userId = nextId();
      const botId = nextId();
      setItems((prev) => [
        ...prev,
        { id: userId, role: "user", content: forceTag ? `${q}  🏷#${forceTag}` : q },
        { id: botId, role: "assistant", content: "", streaming: true },
      ]);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        // khách gửi {} — server tự dùng default (an toàn cả lớp server)
        const effective = isAdmin ? params : {};
        for await (const ev of askStream(q, effective, ac.signal, forceTag)) {
          if (ev.type === "meta") {
            updateItem(botId, { meta: ev });
          } else if (ev.type === "token") {
            setItems((prev) =>
              prev.map((m) =>
                m.id === botId ? { ...m, content: m.content + ev.text } : m,
              ),
            );
          } else if (ev.type === "done") {
            updateItem(botId, {
              done: ev,
              streaming: false,
              content: ev.answer ?? "",
            });
          } else if (ev.type === "error") {
            updateItem(botId, {
              error: ev.message,
              streaming: false,
            });
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          updateItem(botId, { error: String(e), streaming: false });
        }
      } finally {
        updateItem(botId, { streaming: false });
        setBusy(false);
        abortRef.current = null;
        inputRef.current?.focus();
      }
    },
    [busy, params, isAdmin],
  );

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const clearChat = () => {
    if (busy) stop();
    setItems([]);
  };

  const logout = () => {
    if (busy) stop();
    clearSession();
    router.replace("/login");
  };

  // ---- Enter gửi, Shift+Enter xuống dòng ----
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const corpusReady = health?.corpus.loaded ?? false;

  // chưa check xong session → render trống (tránh nhấp nháy)
  if (!authChecked || !session) {
    return <div className="min-h-screen bg-zinc-950" />;
  }

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* ============ SIDEBAR ============ */}
      <aside className="hidden w-80 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40 md:flex">
        <div className="border-b border-zinc-800 px-4 py-4">
          <h1 className="text-base font-bold text-emerald-400">
            🎓 UTC Sổ tay Sinh viên
          </h1>
          <p className="text-xs text-zinc-500">
            RAG 23 tag · Ollama · hybrid BM25+vector
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                isAdmin
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-zinc-600 bg-zinc-800 text-zinc-400"
              }`}
            >
              {isAdmin ? "🛡 Admin" : "👤 Khách"}
            </span>
            <span className="text-xs text-zinc-400">{session.display}</span>
            <button
              onClick={logout}
              className="ml-auto rounded-lg border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-red-700 hover:text-red-400"
              title="Đăng xuất"
            >
              ⎋ Đăng xuất
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {isAdmin ? (
            <ParamsPanel
              health={health}
              healthError={healthError}
              params={params}
              onChange={setParams}
              onReset={() => setParams(DEFAULT_PARAMS)}
              onClearChat={clearChat}
              disabled={busy}
            />
          ) : (
            /* Khách: chỉ trạng thái — không tham số, không nút admin */
            <div className="space-y-3 p-4 text-sm">
              <h2 className="text-xs font-semibold tracking-widest text-zinc-500 uppercase">
                Hệ thống
              </h2>
              <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      health?.ollama.ok ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <span className="text-zinc-300">Ollama</span>
                  <span className="ml-auto text-xs text-zinc-500">
                    {health?.ollama.ok ? "online" : healthError ? "backend?" : "offline"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      corpusReady
                        ? "bg-emerald-500"
                        : health?.corpus.error
                          ? "bg-red-500"
                          : "bg-amber-500 animate-pulse"
                    }`}
                  />
                  <span className="text-zinc-300">Corpus</span>
                  <span className="ml-auto text-xs text-zinc-500">
                    {corpusReady
                      ? "158 chunks ✓"
                      : health?.corpus.error
                        ? "lỗi nạp"
                        : "đang nạp..."}
                  </span>
                </div>
              </div>
              <button
                onClick={clearChat}
                className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 transition hover:bg-zinc-800"
              >
                🗑 Xoá lịch sử chat
              </button>
              <p className="text-[11px] leading-relaxed text-zinc-600">
                Bạn đang ở chế độ <b>Khách</b> — chỉ hỏi đáp. Liên hệ quản trị viên
                nếu cần chỉnh tham số hoặc gán tag.
              </p>
            </div>
          )}
        </div>

        {isAdmin && (
          <div className="border-t border-zinc-800 p-3">
            <button
              onClick={() => setTagManagerOpen(true)}
              className="w-full rounded-lg border border-emerald-700 bg-emerald-900/30 px-3 py-2 text-xs text-emerald-300 transition hover:bg-emerald-800/50"
            >
              🏷 Quản lý định nghĩa hashtag (routing)
            </button>
          </div>
        )}
      </aside>

      {/* ============ CHAT ============ */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <span className="text-lg">💬</span>
          <div>
            <div className="text-sm font-semibold">Hỏi đáp Sổ tay sinh viên K64</div>
            <div className="text-[11px] text-zinc-500">
              {health?.ollama.ok ? "Ollama online" : "Ollama ..."}
              {corpusReady ? " · corpus ✓" : " · corpus đang nạp..."}
              {isAdmin && params.use_llm === false && " · ⚙ chỉ xem tag (không LLM)"}
            </div>
          </div>
          <span
            className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              isAdmin
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-zinc-600 bg-zinc-800 text-zinc-400"
            }`}
          >
            {isAdmin ? "🛡 Admin" : "👤 Khách"}
          </span>
          {busy && (
            <button
              onClick={stop}
              className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-500/10"
            >
              ■ Dừng
            </button>
          )}
        </header>

        {/* Messages */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-4">
            {items.length === 0 && (
              <div className="py-10 text-center">
                <div className="text-5xl">📖</div>
                <h2 className="mt-4 text-lg font-semibold text-zinc-200">
                  Trợ lý Sổ tay sinh viên UTC
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Hỏi về học bổng, kỷ luật, vay vốn, ký túc xá... — trả lời có
                  trích nguồn trang.
                </p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      disabled={busy || !corpusReady}
                      className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-left text-sm text-zinc-300 transition hover:border-emerald-700 hover:text-emerald-300 disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {items.map((m) => (
              <ChatMessage
                key={m.id}
                item={m}
                pickingDisabled={busy}
                onPickTag={(tag, question) => send(question, tag)}
                admin={isAdmin}
              />
            ))}
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-zinc-800 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                corpusReady
                  ? "Nhập câu hỏi... (Enter để gửi, Shift+Enter xuống dòng)"
                  : "Đang nạp corpus, chờ 1 lát..."
              }
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-600"
            />
            <button
              onClick={() => send(input)}
              disabled={busy || !input.trim() || !corpusReady}
              className="h-[44px] shrink-0 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Gửi
            </button>
          </div>
          <p className="mx-auto mt-1.5 max-w-3xl text-[11px] text-zinc-600">
            Trả lời từ model local (Ollama) — chỉ trả lời dựa trên Sổ tay sinh
            viên K64, có trích nguồn [T1]... trang.
          </p>
        </div>
      </main>

      {/* ============ TAG MANAGER (admin) ============ */}
      {tagManagerOpen && isAdmin && (
        <TagManager onClose={() => setTagManagerOpen(false)} />
      )}
    </div>
  );
}
