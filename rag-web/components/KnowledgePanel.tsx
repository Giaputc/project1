"use client";

// components/KnowledgePanel.tsx — Đề xuất tài liệu + rà soát/phê duyệt đáp án.
// Luồng: cán bộ đề xuất/soát → admin duyệt → embedding + index (D3/D4 → D2).

import { useCallback, useEffect, useState } from "react";
import {
  decideAnswer,
  listKnowledge,
  listReviews,
  proposeDoc,
  reloadCorpus,
  reviewAnswer,
  reviewDoc,
  type KnowledgeEntry,
  type ReviewItem,
} from "@/lib/api";

interface Props {
  admin: boolean;
  onClose: () => void;
}

const DOC_STATUS: Record<KnowledgeEntry["status"], string> = {
  de_xuat: "Chờ duyệt",
  da_duyet: "Đã duyệt",
  tu_choi: "Đã từ chối",
};

const REVIEW_STATUS: Record<ReviewItem["status"], string> = {
  cho_rasoat: "Chờ rà soát",
  da_rasoat: "Chờ phê duyệt",
  da_duyet: "Đã duyệt",
  tu_choi: "Đã từ chối",
};

const BTN =
  "h-7 rounded-control border px-2.5 text-[11px] font-medium transition focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-40";
const INPUT =
  "w-full rounded-control border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3";

export default function KnowledgePanel({ admin, onClose }: Props) {
  const [tab, setTab] = useState<"tai_lieu" | "tra_loi">("tai_lieu");
  const [docStatus, setDocStatus] = useState<KnowledgeEntry["status"]>("de_xuat");
  const [rvStatus, setRvStatus] = useState<ReviewItem["status"]>("cho_rasoat");
  const [docs, setDocs] = useState<KnowledgeEntry[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // form đề xuất
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [tag, setTag] = useState("");
  const [source, setSource] = useState("");

  // form rà soát đáp án
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [edited, setEdited] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [d, r] = await Promise.all([
      listKnowledge(docStatus),
      listReviews(rvStatus),
    ]);
    setDocs(d.items);
    setReviews(r.items);
    setCounts({ ...d.counts, ...r.counts });
    setLoading(false);
  }, [docStatus, rvStatus]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submitDoc = async () => {
    if (!title.trim() || !text.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    const r = await proposeDoc({
      title: title.trim(), text: text.trim(),
      tag: tag.trim() || null, source: source.trim() || null,
    });
    setBusy(false);
    if (!r.ok) {
      setMsg({ text: r.error ?? "Không gửi được tài liệu", ok: false });
      return;
    }
    setTitle(""); setText(""); setTag(""); setSource("");
    setMsg({ text: "Đã gửi đề xuất — chờ quản trị viên phê duyệt.", ok: true });
    setDocStatus("de_xuat");
    void load();
  };

  const doDocReview = async (id: string, action: "duyet" | "tu_choi") => {
    setBusy(true);
    setMsg(null);
    const r = await reviewDoc(id, action);
    setBusy(false);
    if (!r.ok) {
      setMsg({ text: r.error ?? "Không duyệt được tài liệu", ok: false });
      return;
    }
    if (action === "duyet" && r.reload && !r.reload.loaded) {
      setMsg({ text: `Đã duyệt nhưng nạp corpus lỗi: ${r.reload.error ?? "?"}`, ok: false });
    } else {
      setMsg({ text: action === "duyet"
        ? "Đã phê duyệt và nạp vào cơ sở tri thức ✓"
        : "Đã từ chối tài liệu.", ok: true });
    }
    void load();
  };

  const doReview = async (id: string) => {
    if (busy) return;
    setBusy(true);
    const r = await reviewAnswer(id, note, edited);
    setBusy(false);
    setEditing(null); setNote(""); setEdited("");
    if (!r.ok) {
      setMsg({ text: r.error ?? "Không lưu được rà soát", ok: false });
      return;
    }
    setMsg({ text: "Đã rà soát — chuyển cho quản trị viên phê duyệt.", ok: true });
    void load();
  };

  const doDecide = async (id: string, action: "duyet" | "tu_choi") => {
    setBusy(true);
    const r = await decideAnswer(id, action);
    setBusy(false);
    if (!r.ok) {
      setMsg({ text: r.error ?? "Không phê duyệt được", ok: false });
      return;
    }
    setMsg({ text: action === "duyet"
      ? "Đã phê duyệt — đáp án vào cơ sở tri thức ✓"
      : "Đã từ chối đáp án.", ok: true });
    void load();
  };

  const doReload = async () => {
    setBusy(true);
    const r = await reloadCorpus();
    setBusy(false);
    setMsg({ text: r.loaded
      ? `Nạp corpus xong (${r.seconds ?? 0}s) — tri thức mới đã có hiệu lực.`
      : `Nạp corpus lỗi: ${r.error ?? "?"}`, ok: !!r.loaded });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
         onClick={onClose} role="presentation">
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded border border-input bg-card enter-rise"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="knowledge-title"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="knowledge-title" className="text-sm font-semibold">
              Tri thức & phê duyệt
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {counts.de_xuat ?? 0} tài liệu chờ duyệt ·{" "}
              {counts.cho_rasoat ?? 0} đáp án chờ rà soát ·{" "}
              {counts.da_rasoat ?? 0} chờ phê duyệt
            </p>
          </div>
          <button onClick={onClose} aria-label="Đóng"
            className="flex size-7 items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-border px-4 py-2" role="tablist">
          {([["tai_lieu", "📄 Tài liệu"], ["tra_loi", "⭐ Đáp án rà soát"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k}
              onClick={() => { setTab(k); setMsg(null); }}
              className={`rounded-control px-3 py-1.5 text-xs font-medium transition focus-visible:ring-3 ${
                tab === k ? "bg-brand-soft text-brand" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}>
              {label}
            </button>
          ))}
          <button onClick={() => void doReload()} disabled={busy}
            className="ml-auto h-7 rounded-control border border-border px-2.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:ring-3 disabled:opacity-40">
            ↻ Nạp lại corpus
          </button>
        </div>

        {msg && (
          <p className={`mx-4 mt-2 rounded-control border px-3 py-2 text-[11px] ${
            msg.ok ? "border-brand-border bg-brand-soft text-brand"
                   : "border-destructive/40 bg-destructive/10 text-destructive"
          }`}>{msg.text}</p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto scroll-area-thin p-4">
          {loading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Đang tải...</p>
          ) : tab === "tai_lieu" ? (
            <div className="space-y-4">
              {/* form đề xuất — cán bộ & admin */}
              <form onSubmit={(e) => { e.preventDefault(); void submitDoc(); }}
                className="space-y-2 rounded-control border border-border bg-background/60 p-3">
                <h3 className="text-xs font-medium">Đề xuất tài liệu mới</h3>
                <input value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder="Tiêu đề tài liệu" className={INPUT} maxLength={200} />
                <textarea value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="Nội dung tài liệu (sẽ được embed để AI truy xuất)" rows={4}
                  className={`${INPUT} resize-none`} maxLength={8000} />
                <div className="flex gap-2">
                  <input value={tag} onChange={(e) => setTag(e.target.value)}
                    placeholder="Chủ đề (tag, không bắt buộc)" className={INPUT} maxLength={64} />
                  <input value={source} onChange={(e) => setSource(e.target.value)}
                    placeholder="Nguồn (link/tài liệu gốc)" className={INPUT} maxLength={300} />
                </div>
                <button type="submit" disabled={busy || !title.trim() || !text.trim()}
                  className="h-8 rounded-control bg-brand px-4 text-xs font-medium text-brand-foreground hover:opacity-90 focus-visible:ring-3 disabled:opacity-40">
                  {busy ? "Đang gửi..." : "Gửi đề xuất →"}
                </button>
              </form>

              <div className="flex gap-1" role="tablist" aria-label="Trạng thái tài liệu">
                {(["de_xuat", "da_duyet", "tu_choi"] as const).map((s) => (
                  <button key={s} onClick={() => setDocStatus(s)}
                    aria-selected={docStatus === s} role="tab"
                    className={`rounded-control px-2.5 py-1 text-[11px] transition focus-visible:ring-3 ${
                      docStatus === s ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent"
                    }`}>
                    {DOC_STATUS[s]} · {counts[s] ?? 0}
                  </button>
                ))}
              </div>

              {docs.length === 0 && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  Không có tài liệu nào ở trạng thái này.
                </p>
              )}
              <ul className="space-y-2">
                {docs.map((d) => (
                  <li key={d.id} className="rounded-control border border-border bg-background/60 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        d.status === "da_duyet"
                          ? "border-brand-border bg-brand-soft text-brand"
                          : d.status === "tu_choi"
                            ? "border-destructive/40 bg-destructive/10 text-destructive"
                            : "border-warning-border bg-warning-soft text-warning"
                      }`}>{DOC_STATUS[d.status]}</span>
                      {d.tag && <span className="font-mono">#{d.tag}</span>}
                      <span className="ml-auto">{d.created_at.replace("T", " ").slice(0, 16)}</span>
                    </div>
                    <p className="mt-1.5 text-sm font-medium">{d.title}</p>
                    <details className="mt-1 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Xem nội dung</summary>
                      <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-2 leading-relaxed">
                        {d.text}
                      </p>
                    </details>
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      Đề xuất: {d.proposed_display ?? d.proposed_by ?? "—"}
                      {d.source ? ` · Nguồn: ${d.source}` : ""}
                    </p>
                    {admin && d.status === "de_xuat" && (
                      <div className="mt-2 flex gap-2">
                        <button disabled={busy} onClick={() => void doDocReview(d.id, "duyet")}
                          className={`${BTN} border-brand-border text-brand hover:bg-brand-soft`}>
                          ✓ Duyệt & nạp vào tri thức
                        </button>
                        <button disabled={busy} onClick={() => void doDocReview(d.id, "tu_choi")}
                          className={`${BTN} border-border text-muted-foreground hover:text-destructive`}>
                          Từ chối
                        </button>
                      </div>
                    )}
                    {d.review_note && (
                      <p className="mt-1 text-[11px] text-muted-foreground">Ghi chú: {d.review_note}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Trạng thái rà soát">
                {(["cho_rasoat", "da_rasoat", "da_duyet", "tu_choi"] as const).map((s) => (
                  <button key={s} onClick={() => setRvStatus(s)} role="tab"
                    aria-selected={rvStatus === s}
                    className={`rounded-control px-2.5 py-1 text-[11px] transition focus-visible:ring-3 ${
                      rvStatus === s ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent"
                    }`}>
                    {REVIEW_STATUS[s]} · {counts[s] ?? 0}
                  </button>
                ))}
              </div>
              {reviews.length === 0 && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Chưa có đáp án ở trạng thái này. Đáp án được sinh viên đánh giá ≥ 4 sao sẽ tự động vào hàng rà soát.
                </p>
              )}
              <ul className="space-y-3">
                {reviews.map((r) => (
                  <li key={r.id} className="rounded-control border border-border bg-background/60 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        r.status === "da_duyet"
                          ? "border-brand-border bg-brand-soft text-brand"
                          : "border-warning-border bg-warning-soft text-warning"
                      }`}>{REVIEW_STATUS[r.status]}</span>
                      {r.tag && <span className="font-mono">#{r.tag}</span>}
                      <span className="ml-auto">{r.created_at.replace("T", " ").slice(0, 16)}</span>
                    </div>
                    <p className="mt-1.5 text-sm font-medium">{r.question}</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                      AI: {r.answer}
                    </p>
                    {(r.final_answer && r.final_answer !== r.answer) && (
                      <p className="mt-1 whitespace-pre-wrap border-l-2 border-brand-border pl-2 text-xs text-foreground">
                        Cán bộ sửa: {r.final_answer}
                      </p>
                    )}

                    {r.status === "cho_rasoat" && (
                      editing === r.id ? (
                        <div className="mt-2 space-y-2">
                          <textarea value={edited} onChange={(e) => setEdited(e.target.value)}
                            rows={3} placeholder="Sửa đáp án nếu cần..." className={`${INPUT} resize-none`} />
                          <input value={note} onChange={(e) => setNote(e.target.value)}
                            placeholder="Ghi chú rà soát" className={INPUT} />
                          <div className="flex gap-2">
                            <button onClick={() => void doReview(r.id)} disabled={busy}
                              className="h-8 rounded-control bg-brand px-3 text-xs font-medium text-brand-foreground hover:opacity-90 disabled:opacity-40">
                              Lưu rà soát
                            </button>
                            <button onClick={() => { setEditing(null); setNote(""); setEdited(""); }}
                              className="h-8 rounded-control border border-border px-3 text-xs text-muted-foreground">
                              Huỷ
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => { setEditing(r.id); setEdited(r.final_answer ?? r.answer); }}
                          className={`${BTN} mt-2 border-brand-border text-brand hover:bg-brand-soft`}>
                          Rà soát →
                        </button>
                      )
                    )}

                    {admin && r.status === "da_rasoat" && (
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => void doDecide(r.id, "duyet")} disabled={busy}
                          className={`${BTN} border-brand-border text-brand hover:bg-brand-soft`}>
                          ✓ Phê duyệt & đưa vào tri thức
                        </button>
                        <button onClick={() => void doDecide(r.id, "tu_choi")} disabled={busy}
                          className={`${BTN} border-border text-muted-foreground hover:text-destructive`}>
                          Từ chối
                        </button>
                      </div>
                    )}
                    {r.note && (
                      <p className="mt-1 text-[11px] text-muted-foreground">Ghi chú: {r.note}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">
          <button onClick={() => void load()} disabled={loading}
            className="h-7 rounded-control border border-border px-3 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
            ↻ Tải lại
          </button>
          <button onClick={onClose}
            className="ml-auto h-7 rounded-control bg-secondary px-3 text-xs font-medium hover:bg-accent">
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
