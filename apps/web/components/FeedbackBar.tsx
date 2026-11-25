"use client";

// components/FeedbackBar.tsx — Đánh giá câu trả lời (nghiệp vụ 4.0 / D4)
// ↑↓ + 1-5 sao + nhận xét → POST /api/feedback

import { useState } from "react";
import { submitFeedback, type FeedbackInput } from "@/lib/api";

interface Props {
  answerId: string;
  question: string;
  answer: string;
  tag?: string | null;
  sources?: string[];
  disabled?: boolean;
}

type Phase = "idle" | "sending" | "saved" | "error";

const STAR_LABELS = ["Rất tệ", "Kém", "Được", "Tốt", "Xuất sắc"];

export default function FeedbackBar({
  answerId,
  question,
  answer,
  tag,
  sources = [],
  disabled,
}: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [expanded, setExpanded] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // đã vote nhanh (không cần sao/nhận xét) → gửi luôn
  const quickVote = async (v: "up" | "down") => {
    if (phase === "sending" || phase === "saved") return;
    setVote(v);
    setPhase("sending");
    setErr(null);
    const ok = await send({ vote: v, so_sao: v === "up" ? 5 : 2 });
    if (!ok) setPhase("idle");
  };

  const send = async (patch: Partial<FeedbackInput>): Promise<boolean> => {
    const finalVote: "up" | "down" = patch.vote ?? vote ?? "up";
    const finalStars = patch.so_sao ?? (stars || (finalVote === "up" ? 5 : 2));
    const body: FeedbackInput = {
      answer_id: answerId,
      question,
      vote: finalVote,
      so_sao: finalStars,
      nhan_xet: (patch.nhan_xet ?? note).trim() || null,
      answer_preview: answer.slice(0, 500),
      answer, // bản đầy đủ — dùng khi cán bộ rà soát & đưa ngược vào tri thức
      tag: tag ?? null,
      sources,
    };
    const r = await submitFeedback(body);
    if (r.ok) {
      setPhase("saved");
      return true;
    }
    setErr(r.error ?? "Gửi thất bại");
    setPhase("error");
    return false;
  };

  const submitFull = async () => {
    if (!stars || phase === "sending") return;
    setPhase("sending");
    setErr(null);
    await send({ vote: stars >= 4 ? "up" : "down", so_sao: stars });
  };

  if (phase === "saved") {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-control border border-brand-border bg-brand-soft px-3 py-2 text-xs text-brand enter-fade">
        <span aria-hidden>✓</span>
        <span>Cảm ơn phản hồi của bạn — dữ liệu sẽ được quản trị viên rà soát.</span>
      </div>
    );
  }

  const shown = hover || stars;

  return (
    <div className="mt-3 border-t border-border pt-3">
      {/* ---- hàng nút chính ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-muted-foreground">
          Câu trả lời này có hữu ích?
        </span>

        <button
          onClick={() => quickVote("up")}
          disabled={disabled || phase === "sending"}
          aria-label="Hữu ích"
          title="Hữu ích"
          className={`flex h-7 items-center gap-1 rounded-control border px-2.5 text-xs transition focus-visible:ring-3 disabled:opacity-50 motion-reduce:transition-none ${
            vote === "up"
              ? "border-brand-border bg-brand-soft text-brand"
              : "border-border bg-secondary text-secondary-foreground hover:bg-accent"
          }`}
        >
          <span aria-hidden>👍</span>
        </button>

        <button
          onClick={() => quickVote("down")}
          disabled={disabled || phase === "sending"}
          aria-label="Chưa hữu ích"
          title="Chưa hữu ích"
          className={`flex h-7 items-center gap-1 rounded-control border px-2.5 text-xs transition focus-visible:ring-3 disabled:opacity-50 motion-reduce:transition-none ${
            vote === "down"
              ? "border-destructive/50 bg-destructive/10 text-destructive"
              : "border-border bg-secondary text-secondary-foreground hover:bg-accent"
          }`}
        >
          <span aria-hidden>👎</span>
        </button>

        <button
          onClick={() => setExpanded((v) => !v)}
          disabled={disabled}
          className="flex h-7 items-center gap-1 rounded-control border border-border bg-secondary px-2.5 text-xs text-secondary-foreground transition hover:bg-accent focus-visible:ring-3 disabled:opacity-50 motion-reduce:transition-none"
          aria-expanded={expanded}
        >
          <span aria-hidden>✎</span> Đánh giá chi tiết
        </button>

        {phase === "sending" && (
          <span className="text-[11px] text-muted-foreground">đang gửi...</span>
        )}
        {phase === "error" && !expanded && err && (
          <span className="text-[11px] text-destructive">⚠ {err}</span>
        )}
      </div>

      {/* ---- form chi tiết ---- */}
      {expanded && (
        <div className="mt-3 space-y-3 rounded-control border border-border bg-card p-3 enter-rise motion-reduce:animation-none">
          {/* sao */}
          <div
            className="flex items-center gap-1"
            onMouseLeave={() => setHover(0)}
            role="radiogroup"
            aria-label="Chấm điểm"
          >
            {[1, 2, 3, 4, 5].map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={stars === s}
                aria-label={`${s} sao — ${STAR_LABELS[s - 1]}`}
                onMouseEnter={() => setHover(s)}
                onFocus={() => setHover(s)}
                onBlur={() => setHover(0)}
                onClick={() => setStars(s)}
                className="flex size-7 items-center justify-center rounded-control text-base leading-none transition hover:bg-accent focus-visible:ring-3 motion-reduce:transition-none"
              >
                <span
                  className={s <= shown ? "text-brand" : "text-muted-foreground/40"}
                  aria-hidden
                >
                  ★
                </span>
              </button>
            ))}
            <span className="ml-2 text-[11px] text-muted-foreground">
              {shown ? STAR_LABELS[shown - 1] : "chấm điểm"}
            </span>
          </div>

          {/* nhận xét */}
          <div>
            <label
              htmlFor={`note-${answerId}`}
              className="block text-[11px] text-muted-foreground"
            >
              Nhận xét (không bắt buộc)
            </label>
            <textarea
              id={`note-${answerId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Trả lời thiếu trang nào? Sai ở đâu?..."
              className="mt-1 w-full resize-none rounded-control border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground outline-none transition focus-visible:border-ring focus-visible:ring-3 motion-reduce:transition-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={submitFull}
              disabled={!stars || phase === "sending"}
              className="h-7 rounded-control bg-brand px-3 text-xs font-medium text-brand-foreground transition hover:opacity-90 focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
            >
              {phase === "sending" ? "Đang gửi..." : "Gửi đánh giá"}
            </button>
            <button
              onClick={() => {
                setExpanded(false);
                setErr(null);
                if (phase === "error") setPhase("idle");
              }}
              disabled={phase === "sending"}
              className="h-7 rounded-control border border-border px-3 text-xs text-muted-foreground transition hover:bg-accent focus-visible:ring-3 disabled:opacity-50 motion-reduce:transition-none"
            >
              Đóng
            </button>
            {phase === "error" && err && (
              <span className="text-[11px] text-destructive">⚠ {err}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
