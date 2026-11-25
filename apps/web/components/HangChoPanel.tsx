"use client";

// components/HangChoPanel.tsx — Cán bộ tư vấn / Admin: xem + trả lời hàng chờ
// câu hỏi AI không xử lý được (nghiệp vụ 3.0 / kho D3).

import { useCallback, useEffect, useState } from "react";
import {
  listHangCho,
  replyHangCho,
  type HangChoCounts,
  type HangChoItem,
} from "@/lib/api";

interface Props {
  onClose: () => void;
}

const EMPTY_COUNTS: HangChoCounts = {
  cho_xu_ly: 0,
  da_tra_loi: 0,
  tong: 0,
};

const STATUS_LABEL: Record<HangChoItem["status"], string> = {
  cho_xu_ly: "Chờ xử lý",
  da_tra_loi: "Đã trả lời",
};

export default function HangChoPanel({ onClose }: Props) {
  const [tab, setTab] = useState<HangChoItem["status"]>("cho_xu_ly");
  const [items, setItems] = useState<HangChoItem[]>([]);
  const [counts, setCounts] = useState<HangChoCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async (s: HangChoItem["status"]) => {
    setLoading(true);
    const r = await listHangCho(s);
    setItems(r.items);
    setCounts(r.counts);
    setLoading(false);
  }, []);

  useEffect(() => {
    // setTimeout 0: tránh setState đồng bộ trong effect (react-hooks rule)
    const t = setTimeout(() => void load(tab), 0);
    return () => clearTimeout(t);
  }, [load, tab]);

  // Esc để đóng
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async (id: string) => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    setError(null);
    const r = await replyHangCho(id, text);
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? "Không gửi được trả lời");
      return;
    }
    setDraft("");
    setReplyFor(null);
    setDone(id);
    await load(tab);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded border border-input bg-card enter-rise"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hangcho-title"
      >
        {/* header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="hangcho-title" className="text-sm font-semibold">
              Chuyển câu hỏi cho cán bộ
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {counts.tong} tổng · {counts.cho_xu_ly} chờ xử lý ·{" "}
              {counts.da_tra_loi} đã trả lời
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-3"
            aria-label="Đóng"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* tabs */}
        <div
          className="flex shrink-0 gap-1 border-b border-border px-4 py-2"
          role="tablist"
          aria-label="Trạng thái hàng chờ"
        >
          {(["cho_xu_ly", "da_tra_loi"] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={tab === s}
              onClick={() => {
                setTab(s);
                setReplyFor(null);
                setError(null);
                setDone(null);
              }}
              className={`rounded-control px-3 py-1.5 text-xs font-medium transition focus-visible:ring-3 ${
                tab === s
                  ? "bg-brand-soft text-brand"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {STATUS_LABEL[s]} · {counts[s]}
            </button>
          ))}
        </div>

        {/* list */}
        <div className="min-h-0 flex-1 overflow-y-auto scroll-area-thin p-4">
          {loading && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <span className="inline-block size-3 animate-spin rounded-full border-2 border-brand border-t-transparent motion-reduce:animate-none" />
              Đang tải hàng chờ...
            </div>
          )}

          {!loading && items.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {tab === "cho_xu_ly"
                ? "Không có câu hỏi nào đang chờ. 🎉"
                : "Chưa có câu hỏi nào được trả lời."}
            </p>
          )}

          {!loading && items.length > 0 && (
            <ul className="space-y-3">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="rounded-control border border-border bg-background/60 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        it.status === "cho_xu_ly"
                          ? "border-warning-border bg-warning-soft text-warning"
                          : "border-brand-border bg-brand-soft text-brand"
                      }`}
                    >
                      {STATUS_LABEL[it.status]}
                    </span>
                    {it.tag && (
                      <span className="font-mono">#{it.tag}</span>
                    )}
                    <span className="ml-auto font-mono">
                      {it.created_at.replace("T", " ").slice(0, 16)}
                    </span>
                  </div>

                  <p className="mt-2 text-sm whitespace-pre-wrap text-foreground">
                    {it.question}
                  </p>

                  {it.reason && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      Lý do chuyển: {it.reason}
                    </p>
                  )}
                  {(it.display || it.user) && (
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      Từ: {it.display ?? "Khách"}
                      {it.user && <span className="ml-1 opacity-70">({it.user})</span>}
                    </p>
                  )}

                  {it.ai_answer && (
                    <details className="mt-2 rounded-control bg-card/70 p-2.5 text-xs">
                      <summary className="cursor-pointer list-none text-muted-foreground">
                        💬 Xem AI đã trả lời gì
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-2 leading-relaxed text-muted-foreground">
                        {it.ai_answer}
                      </p>
                    </details>
                  )}

                  {/* câu trả lời của cán bộ */}
                  {it.status === "da_tra_loi" && it.reply && (
                    <div className="mt-2 rounded-control border border-brand-border bg-brand-soft/50 p-2.5 text-xs">
                      <div className="mb-1 text-[11px] font-medium text-brand">
                        ✓ Trả lời{it.replied_by ? ` · ${it.replied_by}` : ""}
                      </div>
                      <p className="whitespace-pre-wrap leading-relaxed text-foreground">
                        {it.reply}
                      </p>
                    </div>
                  )}

                  {/* lỗi / đã gửi */}
                  {error && replyFor === it.id && (
                    <p className="mt-2 text-[11px] text-destructive">⚠ {error}</p>
                  )}
                  {done === it.id && !replyFor && (
                    <p className="mt-2 text-[11px] text-brand">
                      ✓ Đã gửi trả lời — sinh viên đã nhận thông báo (🔔)
                    </p>
                  )}

                  {/* form trả lời */}
                  {replyFor === it.id ? (
                    <div className="mt-2.5">
                      <label
                        htmlFor={`reply-${it.id}`}
                        className="sr-only"
                      >
                        Nhập trả lời cho sinh viên
                      </label>
                      <textarea
                        id={`reply-${it.id}`}
                        rows={4}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Nhập trả lời chính thức từ cán bộ tư vấn..."
                        autoFocus
                        className="w-full resize-none rounded-control border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3"
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => void send(it.id)}
                          disabled={saving || !draft.trim()}
                          className="h-8 rounded-control bg-brand px-4 text-xs font-medium text-brand-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-3"
                        >
                          {saving ? "Đang gửi..." : "Gửi trả lời"}
                        </button>
                        <button
                          onClick={() => {
                            setReplyFor(null);
                            setDraft("");
                            setError(null);
                          }}
                          disabled={saving}
                          className="h-8 rounded-control border border-border px-3 text-xs text-muted-foreground transition hover:text-foreground focus-visible:ring-3 disabled:opacity-40"
                        >
                          Huỷ
                        </button>
                      </div>
                    </div>
                  ) : (
                    it.status === "cho_xu_ly" && (
                      <button
                        onClick={() => {
                          setReplyFor(it.id);
                          setDraft("");
                          setError(null);
                          setDone(null);
                        }}
                        className="mt-2.5 h-8 rounded-control border border-brand-border px-3 text-xs font-medium text-brand transition hover:bg-brand-soft focus-visible:ring-3"
                      >
                        Trả lời →
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* footer */}
        <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2.5">
          <button
            onClick={() => void load(tab)}
            disabled={loading}
            className="h-7 rounded-control border border-border px-3 text-xs text-muted-foreground transition hover:text-foreground focus-visible:ring-3 disabled:opacity-40"
          >
            ↻ Tải lại
          </button>
          <button
            onClick={onClose}
            className="ml-auto h-7 rounded-control bg-secondary px-3 text-xs font-medium text-foreground transition hover:bg-accent focus-visible:ring-3"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
