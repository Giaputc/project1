"use client";

// app/page.tsx — Chat RAG Sổ tay sinh viên UTC
// Khách: chỉ chat. Admin: + panel tham số, preheat, reload, gán tag, quản lý tag.
// App shell theo reference: sidebar 16rem (collapse icon) · header hairline ·
// content padding 6/8/10 · controls radius 4px.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ParamsPanel from "@/components/ParamsPanel";
import ChatMessage, {
  type ChatItem,
  type TransferPayload,
} from "@/components/ChatMessage";
import TagManager from "@/components/TagManager";
import FeedbackStats from "@/components/FeedbackStats";
import HangChoPanel from "@/components/HangChoPanel";
import NotificationBell from "@/components/NotificationBell";
import KnowledgePanel from "@/components/KnowledgePanel";
import AdminPanel, { type Tab as AdminTab } from "@/components/AdminPanel";
import {
  addHangCho,
  askStream,
  clearSession,
  deleteHistorySession,
  fetchHealth,
  getSession,
  listHangCho,
  listHistorySessions,
  loadHistorySession,
  readActiveSid,
  saveActiveSid,
  saveHistoryItem,
  type DoneEvent,
  type Health,
  type HangChoCounts,
  type HistorySession,
  type MetaEvent,
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

/** id phiên chat — randomUUID trên trình duyệt hiện đại, fallback otherwise */
const makeSid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const EMPTY_QUEUE: HangChoCounts = { cho_xu_ly: 0, da_tra_loi: 0, tong: 0 };

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
  // navOpen = thu gọn (desktop) · drawer = mở thanh bên (mobile)
  const [navOpen, setNavOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);

  // ---- Lịch sử câu hỏi (nghiệp vụ 1.0 / D1) ----
  // activeSid khởi tạo rỗng: randomUUID không được gọi lúc prerender (SSG) —
  // được sinh trong event handler (send/newSession/openSession) thay vì render.
  const [activeSid, setActiveSid] = useState<string>("");
  const [history, setHistory] = useState<HistorySession[]>([]);
  const [loadingSid, setLoadingSid] = useState<string | null>(null);

  // ---- Hàng chờ cán bộ (nghiệp vụ 3.0 / D3) ----
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueCounts, setQueueCounts] = useState<HangChoCounts>(EMPTY_QUEUE);

  // ---- Tri thức & quản trị (nghiệp vụ 4.0/5.0/6.0) ----
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTab>("users");

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isAdmin = session?.role === "admin";
  const isStaff = session?.role === "admin" || session?.role === "can_bo";

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

  // ---- Nạp danh sách phiên + số liệu hàng chờ ----
  const refreshHistory = useCallback(async () => {
    const rows = await listHistorySessions();
    setHistory(rows);
    return rows;
  }, []);

  const refreshQueue = useCallback(async () => {
    const r = await listHangCho();
    setQueueCounts(r.counts);
  }, []);

  // Khôi phục đúng phiên của danh tính hiện tại (admin / canbo / sv / guest riêng)
  useEffect(() => {
    if (!authChecked || !session) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void refreshHistory().then(async (rows) => {
        void refreshQueue();
        const saved = readActiveSid(session.username);
        if (cancelled || !saved) return;
        if (!rows.some((h) => h.session_id === saved)) return;
        const loaded = await loadHistorySession(saved);
        if (cancelled) return;
        setActiveSid(saved);
        setItems(loaded);
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [authChecked, session, refreshHistory, refreshQueue]);

  // Mỗi danh tính nhớ 1 phiên đang mở — không đè phiên của role/user khác
  useEffect(() => {
    if (!session?.username || !activeSid) return;
    saveActiveSid(session.username, activeSid);
  }, [session, activeSid]);

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

      // phiên đầu tiên → sinh id ngay tại event handler (không lúc prerender)
      const sid = activeSid || makeSid();
      if (!activeSid) setActiveSid(sid);
      const userId = nextId();
      const botId = nextId();
      const displayQ = forceTag ? `${q}  🏷#${forceTag}` : q;
      setItems((prev) => [
        ...prev,
        { id: userId, role: "user", content: displayQ },
        {
          id: botId,
          role: "assistant",
          content: "",
          streaming: true,
          question: q,
        },
      ]);
      // lưu tin nhắn user ngay (phiên mới cũng kịp có mặt trong danh sách)
      void saveHistoryItem(sid, {
        id: userId,
        role: "user",
        content: displayQ,
      });

      const ac = new AbortController();
      abortRef.current = ac;

      // bản sao để lưu lịch sử — tránh đọc state đã set
      let acc = "";
      let metaEv: MetaEvent | undefined;
      let doneEv: DoneEvent | undefined;
      let errEv: string | undefined;
      let aborted = false;

      try {
        // khách gửi {} — server tự dùng default (an toàn cả lớp server)
        const effective = isAdmin ? params : {};
        for await (const ev of askStream(q, effective, ac.signal, forceTag)) {
          if (ev.type === "meta") {
            metaEv = ev;
            updateItem(botId, { meta: ev });
          } else if (ev.type === "token") {
            acc += ev.text;
            setItems((prev) =>
              prev.map((m) =>
                m.id === botId ? { ...m, content: m.content + ev.text } : m,
              ),
            );
          } else if (ev.type === "done") {
            doneEv = ev;
            acc = ev.answer ?? acc;
            updateItem(botId, {
              done: ev,
              streaming: false,
              content: ev.answer ?? "",
            });
          } else if (ev.type === "error") {
            errEv = ev.message;
            updateItem(botId, { error: ev.message, streaming: false });
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          aborted = true; // dừng giữa chừng → không lưu bản dở dang
        } else {
          errEv = String(e);
          updateItem(botId, { error: String(e), streaming: false });
        }
      } finally {
        updateItem(botId, { streaming: false });
        if (!aborted) {
          void saveHistoryItem(sid, {
            id: botId,
            role: "assistant",
            content: acc,
            question: q,
            meta: metaEv,
            done: doneEv,
            error: errEv,
          }).then(() => refreshHistory());
        }
        setBusy(false);
        abortRef.current = null;
        inputRef.current?.focus();
      }
    },
    [busy, params, isAdmin, activeSid, refreshHistory],
  );

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const clearChat = () => {
    if (busy) stop();
    setItems([]);
    // bắt đầu phiên trống — câu hỏi tiếp theo không dính vào phiên cũ
    setActiveSid(makeSid());
  };

  // ---- Phiên: mới / mở lại / xoá (nghiệp vụ 1.0 / D1) ----
  const newSession = () => {
    clearChat();
    setDrawer(false);
  };

  const openSession = async (sid: string) => {
    if (busy || loadingSid) return;
    setLoadingSid(sid);
    const loaded = await loadHistorySession(sid);
    setActiveSid(sid);
    setItems(loaded);
    setLoadingSid(null);
    setDrawer(false);
    inputRef.current?.focus();
  };

  const removeSession = async (e: React.MouseEvent, sid: string) => {
    e.stopPropagation();
    await deleteHistorySession(sid);
    if (sid === activeSid) {
      setItems([]);
      setActiveSid(makeSid());
    }
    void refreshHistory();
  };

  // ---- Chuyển câu hỏi cho cán bộ (nghiệp vụ 3.0 / D3) ----
  const transferToStaff = useCallback(
    async (p: TransferPayload) => {
      const r = await addHangCho(p);
      if (r.ok) void refreshQueue();
      return { ok: r.ok, error: r.error };
    },
    [refreshQueue],
  );

  const logout = () => {
    if (busy) stop();
    clearSession();
    setItems([]);
    setActiveSid("");
    setDrawer(false);
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
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* ============ SIDEBAR (16rem → collapse icon 3rem · mobile drawer) ============ */}
      {drawer && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setDrawer(false)}
          aria-hidden
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 ease-linear motion-reduce:transition-none md:static md:z-auto md:translate-x-0 md:transition-[width] ${
          drawer ? "translate-x-0" : "-translate-x-full max-md:invisible"
        } ${navOpen ? "md:w-64" : "md:w-12"}`}
      >
        {/* sidebar-header */}
        <div className="flex items-center gap-2 border-b border-sidebar-border px-2 py-2">
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-control bg-brand-soft text-[13px] leading-none"
          >
            🎓
          </span>
          {navOpen && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">UTC Sổ tay</div>
              <div className="truncate text-[11px] text-muted-foreground">
                K64 · RAG 23 tag
              </div>
            </div>
          )}
          {/* thu gọn (desktop) */}
          <button
            onClick={() => setNavOpen((v) => !v)}
            className="ml-auto hidden size-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 md:flex"
            aria-label={navOpen ? "Thu gọn thanh bên" : "Mở thanh bên"}
            title={navOpen ? "Thu gọn" : "Mở rộng"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
          {/* đóng drawer (mobile) */}
          <button
            onClick={() => setDrawer(false)}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 md:hidden"
            aria-label="Đóng thanh bên"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* sidebar-content */}
        <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-2">
          {/* ---- nhóm: phiên + lịch sử (nghiệp vụ 1.0 / D1) ---- */}
          <nav aria-label="Phiên chat" className="flex flex-col gap-0.5">
            {navOpen && (
              <div className="flex h-8 items-center px-3 text-xs font-medium text-muted-foreground/70">
                Phiên
              </div>
            )}
            <button
              onClick={newSession}
              className="flex h-8 w-full items-center gap-2 overflow-hidden rounded-control px-3 text-left text-sm transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 disabled:opacity-50"
              disabled={busy}
              title="Bắt đầu phiên hỏi đáp mới"
            >
              <svg className="size-4 shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              {navOpen && <span className="truncate">Phiên mới</span>}
            </button>

            {navOpen &&
              history.map((h) => {
                const isActive = h.session_id === activeSid;
                const isLoading = loadingSid === h.session_id;
                return (
                  <div
                    key={h.session_id}
                    className="group flex items-center gap-0.5"
                  >
                    <button
                      onClick={() => void openSession(h.session_id)}
                      disabled={busy || !!loadingSid}
                      title={h.preview || "Phiên trống"}
                      className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control px-3 text-left text-sm transition focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 ${
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      }`}
                    >
                      {isLoading ? (
                        <span
                          aria-hidden
                          className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent motion-reduce:animate-none"
                        />
                      ) : (
                        <svg
                          aria-hidden
                          className={`size-3.5 shrink-0 ${
                            isActive ? "text-brand" : "text-muted-foreground/70"
                          }`}
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
                        </svg>
                      )}
                      <span className="truncate">
                        {h.preview || "Phiên trống"}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {h.n_messages}
                      </span>
                    </button>
                    <button
                      onClick={(e) => void removeSession(e, h.session_id)}
                      disabled={busy || !!loadingSid}
                      aria-label={`Xoá phiên: ${h.preview || "trống"}`}
                      title="Xoá phiên này"
                      className="size-6 shrink-0 rounded text-muted-foreground/50 opacity-60 transition hover:text-destructive hover:opacity-100 focus-visible:ring-3 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <svg
                        aria-hidden
                        className="mx-auto size-3.5"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}

            {navOpen && history.length === 0 && (
              <p className="px-3 py-1 text-[11px] text-muted-foreground/60">
                Chưa có phiên nào — hỏi câu đầu tiên để bắt đầu
              </p>
            )}
          </nav>

          {/* ---- nhóm: Hệ thống ---- */}
          <nav aria-label="Hệ thống" className="flex flex-col gap-0.5">
            {navOpen && (
              <div className="flex h-8 items-center px-3 text-xs font-medium text-muted-foreground/70">
                Hệ thống
              </div>
            )}
            <div
              className="rounded-control px-2 py-1.5"
              title="Trạng thái dịch vụ"
            >
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    health?.ollama.ok ? "bg-brand" : "bg-destructive"
                  }`}
                />
                {navOpen && (
                  <>
                    <span className="truncate text-sidebar-foreground">
                      Ollama
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {health?.ollama.ok
                        ? "online"
                        : healthError
                          ? "backend?"
                          : "offline"}
                    </span>
                  </>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-xs">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    corpusReady
                      ? "bg-brand"
                      : health?.corpus.error
                        ? "bg-destructive"
                        : "animate-pulse bg-warning"
                  }`}
                />
                {navOpen && (
                  <>
                    <span className="truncate text-sidebar-foreground">
                      Corpus
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {corpusReady
                        ? "158 chunks ✓"
                        : health?.corpus.error
                          ? "lỗi nạp"
                          : "đang nạp..."}
                    </span>
                  </>
                )}
              </div>
            </div>
          </nav>

          {/* ---- nhóm: Cán bộ tư vấn (admin + can_bo) ---- */}
          {isStaff && (
            <nav aria-label="Cán bộ tư vấn" className="flex flex-col gap-0.5">
              {navOpen && (
                <div className="flex h-8 items-center px-3 text-xs font-medium text-muted-foreground/70">
                  Cán bộ tư vấn
                </div>
              )}
              <button
                onClick={() => {
                  setQueueOpen(true);
                  setDrawer(false);
                }}
                className="relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-control px-3 text-left text-sm transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3"
                title="Câu hỏi sinh viên chuyển sang — chờ cán bộ trả lời"
              >
                <svg
                  aria-hidden
                  className="size-4 shrink-0"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 6v6l4 2" />
                  <circle cx="12" cy="12" r="10" />
                </svg>
                {navOpen && (
                  <>
                    <span className="truncate">Hàng chờ câu hỏi</span>
                    {queueCounts.cho_xu_ly > 0 && (
                      <span className="ml-auto shrink-0 rounded-full border border-warning-border bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                        {queueCounts.cho_xu_ly}
                      </span>
                    )}
                  </>
                )}
                {!navOpen && queueCounts.cho_xu_ly > 0 && (
                  <span
                    aria-hidden
                    className="absolute right-1.5 top-1.5 size-2 rounded-full bg-warning"
                  />
                )}
              </button>
              <button
                onClick={() => {
                  setKnowledgeOpen(true);
                  setDrawer(false);
                }}
                className="flex h-8 w-full items-center gap-2 overflow-hidden rounded-control px-3 text-left text-sm transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3"
                title="Đề xuất tài liệu, rà soát đáp án, xem phê duyệt"
              >
                <svg aria-hidden className="size-4 shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
                </svg>
                {navOpen && <span className="truncate">Tri thức & phê duyệt</span>}
              </button>
            </nav>
          )}

          {/* ---- nhóm: Quản trị (admin) ---- */}
          {isAdmin && (
            <nav aria-label="Quản trị" className="flex flex-col gap-0.5">
              {navOpen && (
                <div className="flex h-8 items-center px-3 text-xs font-medium text-muted-foreground/70">
                  Quản trị
                </div>
              )}
              {navOpen ? (
                <ParamsPanel
                  health={health}
                  params={params}
                  onChange={setParams}
                  onReset={() => setParams(DEFAULT_PARAMS)}
                  onClearChat={clearChat}
                  disabled={busy}
                />
              ) : (
                <button
                  onClick={() => setNavOpen(true)}
                  className="flex h-8 w-full items-center justify-center rounded-control text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3"
                  aria-label="Mở bảng tham số"
                  title="Bảng tham số RAG"
                >
                  <svg className="size-4" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 17H5" />
                    <path d="M19 7h-9" />
                    <circle cx="17" cy="17" r="3" />
                    <circle cx="7" cy="7" r="3" />
                  </svg>
                </button>
              )}
              <button
                onClick={() => {
                  setTagManagerOpen(true);
                  setDrawer(false);
                }}
                className="flex h-8 w-full items-center gap-2 overflow-hidden rounded-control px-3 text-left text-sm transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3"
                title="Quản lý định nghĩa hashtag (routing)"
              >
                <svg className="size-4 shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
                  <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
                </svg>
                {navOpen && (
                  <span className="truncate">Quản lý hashtag</span>
                )}
              </button>
              <button
                onClick={() => {
                  setAdminTab("users");
                  setAdminOpen(true);
                  setDrawer(false);
                }}
                className="flex h-8 w-full items-center gap-2 overflow-hidden rounded-control px-3 text-left text-sm transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3"
                title="Quản lý người dùng, phân quyền, chủ đề"
              >
                <svg aria-hidden className="size-4 shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M19 8v6M22 11h-6" />
                </svg>
                {navOpen && <span className="truncate">Người dùng & phân quyền</span>}
              </button>
              <button
                onClick={() => {
                  setAdminTab("reports");
                  setAdminOpen(true);
                  setDrawer(false);
                }}
                className="flex h-8 w-full items-center gap-2 overflow-hidden rounded-control px-3 text-left text-sm transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3"
                title="Báo cáo từ lịch sử, đánh giá, hàng chờ"
              >
                <svg aria-hidden className="size-4 shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="m19 9-5 5-4-4-3 3" />
                </svg>
                {navOpen && <span className="truncate">Báo cáo hệ thống</span>}
              </button>
            </nav>
          )}
        </div>

        {/* sidebar-footer: user */}
        <div className="border-t border-sidebar-border p-2">
          <div className="flex items-center gap-2 rounded-control px-2 py-1.5">
            <span
              title={session.username}
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
            >
              {isAdmin
                ? "AD"
                : session.role === "can_bo"
                  ? "CB"
                  : session.role === "sinh_vien"
                    ? "SV"
                    : "KH"}
            </span>
            {navOpen && (
              <>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {session.display}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {isAdmin
                      ? "Quản trị viên"
                      : session.role === "can_bo"
                        ? "Cán bộ tư vấn"
                        : session.role === "sinh_vien"
                          ? "Sinh viên"
                          : "Khách"}
                  </div>
                </div>
                <button
                  onClick={logout}
                  className="flex size-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition hover:bg-sidebar-accent hover:text-destructive focus-visible:ring-3"
                  title="Đăng xuất"
                  aria-label="Đăng xuất"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" x2="9" y1="12" y2="12" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <main
        id="main-content"
        tabIndex={-1}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      >
        {/* header — hairline, min-h 2.5rem */}
        <header className="flex min-h-[calc(2.5rem+1px)] shrink-0 items-center gap-3 border-b border-border px-3 py-1.5 sm:px-6">
          <button
            onClick={() => setDrawer(true)}
            className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition hover:bg-accent focus-visible:ring-3 md:hidden"
            aria-label="Mở thanh bên"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
          <span className="hidden text-muted-foreground sm:inline" aria-hidden>
            <svg className="size-4" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
            </svg>
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">
              Hỏi đáp Sổ tay sinh viên K64
            </h1>
            <p className="truncate text-[11px] text-muted-foreground">
              {health?.ollama.ok ? "Ollama online" : "Ollama ..."}
              {corpusReady ? " · corpus ✓" : " · corpus đang nạp..."}
              {isAdmin && params.use_llm === false && " · ⚙ chỉ xem tag"}
            </p>
          </div>

          <div className="ml-auto shrink-0">
            <NotificationBell />
          </div>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              isAdmin
                ? "border-brand-border bg-brand-soft text-brand"
                : session.role === "can_bo"
                  ? "border-warning-border bg-warning-soft text-warning"
                  : "border-border bg-secondary text-muted-foreground"
            }`}
          >
            {isAdmin
              ? "Quản trị"
              : session.role === "can_bo"
                ? "Cán bộ"
                : session.role === "sinh_vien"
                  ? "Sinh viên"
                  : "Khách"}
          </span>

          {busy && (
            <button
              onClick={stop}
              className="flex h-7 shrink-0 items-center gap-1 rounded-control border border-destructive/40 px-3 text-xs font-medium text-destructive transition hover:bg-destructive/10 focus-visible:ring-3 motion-reduce:transition-none"
            >
              <span aria-hidden>■</span> Dừng
            </button>
          )}
        </header>

        {/* messages — padding 6/8/10 như reference */}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto scroll-area-thin"
        >
          <div
            className={`mx-auto w-full max-w-3xl px-6 py-8 sm:px-8 lg:px-10 ${
              items.length === 0 ? "surface-atmosphere" : ""
            }`}
          >
            {items.length === 0 && <EmptyState onPick={send} busy={busy} ready={corpusReady} />}

            <div className="space-y-4">
              {items.map((m) => (
                <ChatMessage
                  key={m.id}
                  item={m}
                  pickingDisabled={busy}
                  onPickTag={(tag, question) => send(question, tag)}
                  admin={isAdmin}
                  onTransfer={transferToStaff}
                />
              ))}
            </div>
          </div>
        </div>

        {/* input dock */}
        <div className="shrink-0 border-t border-border px-6 py-3 sm:px-8 lg:px-10">
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
            <label htmlFor="chat-input" className="sr-only">
              Nhập câu hỏi
            </label>
            <textarea
              id="chat-input"
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
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-control border border-input bg-background px-3.5 py-3 text-sm placeholder:text-muted-foreground outline-none transition focus-visible:border-ring focus-visible:ring-3 motion-reduce:transition-none"
            />
            <button
              onClick={() => send(input)}
              disabled={busy || !input.trim() || !corpusReady}
              className="h-[44px] shrink-0 rounded-control bg-brand px-5 text-sm font-medium text-brand-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-3 focus-visible:ring-ring/40 motion-reduce:transition-none"
            >
              Gửi
            </button>
          </div>
          <p className="mx-auto mt-1.5 w-full max-w-3xl text-[11px] text-muted-foreground/70">
            Trả lời từ model local (Ollama) — chỉ dựa trên Sổ tay sinh viên K64,
            có trích nguồn [T1]... trang.
          </p>
        </div>

        {/* admin: block đánh giá */}
        {isAdmin && <FeedbackStats />}
      </main>

      {/* ============ TAG MANAGER (admin) ============ */}
      {tagManagerOpen && isAdmin && (
        <TagManager onClose={() => setTagManagerOpen(false)} />
      )}

      {/* ============ HÀNG CHỜ CÁN BỘ (nghiệp vụ 3.0 / D3) ============ */}
      {queueOpen && isStaff && (
        <HangChoPanel
          onClose={() => {
            setQueueOpen(false);
            void refreshQueue();
            void refreshHistory();
          }}
        />
      )}

      {/* ============ TRI THỨC & PHÊ DUYỆT (Cán bộ / Admin) ============ */}
      {knowledgeOpen && isStaff && (
        <KnowledgePanel
          admin={isAdmin}
          onClose={() => {
            setKnowledgeOpen(false);
            void refreshQueue();
          }}
        />
      )}

      {/* ============ QUẢN TRỊ HỆ THỐNG (Admin) ============ */}
      {adminOpen && isAdmin && (
        <AdminPanel initialTab={adminTab} onClose={() => setAdminOpen(false)} />
      )}
    </div>
  );
}

// ============================================================
// EMPTY STATE — memorable moment: atmosphere + hierarchy
// ============================================================
function EmptyState({
  onPick,
  busy,
  ready,
}: {
  onPick: (q: string) => void;
  busy: boolean;
  ready: boolean;
}) {
  const [featured, ...rest] = SUGGESTIONS;

  return (
    <div className="enter-rise pb-6 pt-4">
      <p
        className="font-mono text-[11px] tracking-[0.18em] text-muted-foreground uppercase enter-fade"
        style={{ animationDelay: "40ms" }}
      >
        Sổ tay sinh viên K64
      </p>
      <h2
        className="mt-3 text-3xl font-semibold tracking-tight text-balance enter-rise sm:text-4xl"
        style={{ animationDelay: "80ms" }}
      >
        Hỏi bất cứ điều gì về
        <span className="text-brand"> đời sống học vụ</span>.
      </h2>
      <p
        className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground enter-fade"
        style={{ animationDelay: "160ms" }}
      >
        Học bổng · kỷ luật · vay vốn · ký túc xá · ngoại ngữ đầu ra. Câu trả lời
        được truy xuất từ tài liệu chính thức và trích dẫn đúng trang.
      </p>

      {/* featured — phá lưới đối xứng */}
      <button
        onClick={() => onPick(featured)}
        disabled={busy || !ready}
        style={{ animationDelay: "240ms" }}
        className="group mt-8 flex w-full items-center gap-4 rounded border border-border bg-card/70 px-5 py-4 text-left transition hover:border-brand-border hover:bg-card focus-visible:ring-3 disabled:opacity-50 enter-rise motion-reduce:transition-none"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-brand-soft text-sm text-brand">
          ↗
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] tracking-wider text-muted-foreground uppercase">
            Câu hỏi phổ biến
          </span>
          <span className="mt-0.5 block truncate text-sm font-medium">
            {featured}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground transition group-hover:text-brand motion-reduce:transition-none">
          Hỏi →
        </span>
      </button>

      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {rest.map((s, i) => (
          <li key={s}>
            <button
              onClick={() => onPick(s)}
              disabled={busy || !ready}
              style={{ animationDelay: `${300 + i * 60}ms` }}
              className="w-full rounded-control border border-border/70 bg-card/50 px-4 py-3 text-left text-sm text-muted-foreground transition hover:border-border hover:bg-card hover:text-foreground focus-visible:ring-3 disabled:opacity-50 enter-rise motion-reduce:transition-none"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
