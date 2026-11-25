"use client";

// components/ChatMessage.tsx — 1 cặp tin nhắn (user / assistant) trong chat

import { useState } from "react";
import type { DoneEvent, MetaEvent } from "@/lib/api";
import TagEditor from "@/components/TagEditor";
import FeedbackBar from "@/components/FeedbackBar";

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;             // text trả lời (streaming dần)
  question?: string;           // câu hỏi gốc (client biết khi gửi — cần cho D3)
  meta?: MetaEvent;
  done?: DoneEvent;
  error?: string;
  streaming?: boolean;
}

/** Payload chuyển câu hỏi cho cán bộ (nghiệp vụ 3.0 / D3) */
export interface TransferPayload {
  question: string;
  answer_id?: string | null;
  tag?: string | null;
  reason: string;
  ai_answer?: string | null;
}

const DECISION_STYLE: Record<string, { label: string; cls: string }> = {
  ANSWER: {
    label: "✓ TRẢ LỜI",
    cls: "border-brand-border bg-brand-soft text-brand",
  },
  ASK_BACK: {
    label: "? HỎI LẠI",
    cls: "border-warning-border bg-warning-soft text-warning",
  },
  OUT_OF_SCOPE: {
    label: "✕ NGOÀI TÀI LIỆU",
    cls: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

function Sources({ meta, admin }: { meta: MetaEvent; admin?: boolean }) {
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  // tag local đã sửa (optimistic) theo chunk id
  const [localTags, setLocalTags] = useState<Record<string, string[]>>({});
  const [localManual, setLocalManual] = useState<Record<string, boolean>>({});
  if (!meta.sources.length) return null;

  return (
    <div className="mt-3 rounded-control border border-border bg-card/60">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-t-control px-3 py-2 text-left text-xs text-muted-foreground transition hover:text-foreground focus-visible:ring-3 motion-reduce:transition-none"
      >
        <span>
          📄 Nguồn [{meta.sources.map((s) => `T${s.rank}`).join(", ")}]
        </span>
        <span className="ml-auto text-[9px]" aria-hidden>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border p-3">
          {meta.sources.map((s) => {
            const tags = localTags[s.id] ?? s.tags;
            const manual = localManual[s.id] ?? false;
            return (
              <details
                key={s.id + s.rank}
                className="rounded-control bg-background/60 p-2.5 text-xs"
              >
                <summary className="cursor-pointer list-none">
                  <span className="font-mono text-brand">[T{s.rank}]</span>{" "}
                  <span className="font-mono text-muted-foreground">{s.id}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · tr.{s.page_start}
                    {s.page_end !== s.page_start ? `-${s.page_end}` : ""}
                  </span>
                  {tags.map((t) => (
                    <span
                      key={t}
                      className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                        manual && t === tags[0]
                          ? "bg-brand-soft text-brand"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      #{t}
                    </span>
                  ))}
                  <span className="mt-1 block text-foreground">{s.heading}</span>
                </summary>
                <p className="mt-2 whitespace-pre-wrap border-l-2 border-brand-border pl-2 leading-relaxed text-muted-foreground">
                  {s.text}
                </p>
                {admin && (
                  <>
                    <button
                      onClick={() => setEditId(editId === s.id ? null : s.id)}
                      className="mt-2 rounded-control border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:border-brand-border hover:text-brand focus-visible:ring-3 motion-reduce:transition-none"
                    >
                      🏷 {editId === s.id ? "Đóng trình sửa tag" : "Sửa tag đoạn này"}
                    </button>
                    {editId === s.id && (
                      <TagEditor
                        chunkId={s.id}
                        currentTags={tags}
                        isManual={manual}
                        onSaved={(newTags, isManual) => {
                          setLocalTags((p) => ({ ...p, [s.id]: newTags }));
                          setLocalManual((p) => ({ ...p, [s.id]: isManual }));
                        }}
                      />
                    )}
                  </>
                )}
              </details>
            );
          })}
          {meta.global_fallback.length > 0 && (
            <p className="text-[11px] text-muted-foreground/70">
              global fallback: {meta.global_fallback.join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StatsLine({ meta, done }: { meta: MetaEvent; done?: DoneEvent }) {
  const s = done?.stats;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground/70">
      <span>tag #{meta.top_tag}</span>
      <span>· {meta.elapsed_s}s</span>
      {s && (
        <>
          {s.cold_start && <span className="text-warning">· cold start ⚠</span>}
          <span>
            · prompt {s.prompt_ms?.toFixed(0)}ms ({s.prompt_tokens} tok
            {s.prompt_cached ? `, cache ${s.prompt_cached}` : ""})
          </span>
          <span>
            · sinh {s.gen_ms?.toFixed(0)}ms ({s.out_tokens} tok)
          </span>
          {s.truncated && (
            <span className="text-warning">· chạm trần max_tokens ⚠</span>
          )}
        </>
      )}
      {done?.skipped_llm && <span>· bỏ qua LLM ({done.reason})</span>}
    </div>
  );
}

interface Props {
  item: ChatItem;
  onPickTag?: (tag: string, question: string) => void;
  pickingDisabled?: boolean;
  admin?: boolean;
  /** Chuyển câu hỏi sang hàng chờ cán bộ (D3) */
  onTransfer?: (p: TransferPayload) => Promise<{ ok: boolean; error?: string }>;
}

export default function ChatMessage({
  item,
  onPickTag,
  pickingDisabled,
  admin,
  onTransfer,
}: Props) {
  // hooks phải gọi trước nhánh return của user message
  const [transfer, setTransfer] = useState<"idle" | "sending" | "done">("idle");
  const [transferErr, setTransferErr] = useState<string | null>(null);

  const isUser = item.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded rounded-br-sm bg-brand px-4 py-2.5 text-sm whitespace-pre-wrap text-brand-foreground">
          {item.content}
        </div>
      </div>
    );
  }

  const dec = item.meta ? DECISION_STYLE[item.meta.decision] : null;
  const answerId = item.done?.answer_id ?? item.meta?.answer_id;
  const question = item.question ?? item.meta?.question ?? "";
  // chỉ đánh giá khi có trả lời thật (không lỗi, không stream, không bỏ qua LLM)
  const canFeedback =
    !!answerId &&
    !item.error &&
    !item.streaming &&
    !!item.done &&
    !item.done.skipped_llm &&
    !!(item.done.answer ?? item.content);

  // lý do chuyển — suy ra từ quyết định của router
  const transferReason = item.error
    ? "Model lỗi hoặc quá thời gian"
    : item.meta?.decision === "OUT_OF_SCOPE"
      ? "AI trả lời ngoài tài liệu"
      : item.meta?.decision === "ASK_BACK"
        ? "Câu hỏi mơ hồ — AI hỏi lại, sinh viên chưa chọn được tag"
        : "Sinh viên thấy câu trả lời chưa phù hợp";

  const doTransfer = async () => {
    if (!onTransfer || transfer === "sending" || !question) return;
    setTransfer("sending");
    setTransferErr(null);
    const r = await onTransfer({
      question,
      answer_id: answerId ?? null,
      tag: item.meta?.top_tag ?? null,
      reason: transferReason,
      ai_answer: item.content || null,
    });
    if (r.ok) {
      setTransfer("done");
    } else {
      setTransfer("idle");
      setTransferErr(r.error ?? "Không chuyển được câu hỏi");
    }
  };

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] space-y-1">
        <div className="rounded rounded-bl-sm border border-border bg-card px-4 py-3 text-sm text-foreground">
          {/* Decision badge + why */}
          {item.meta && dec && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${dec.cls}`}
              >
                {dec.label}
              </span>
              {item.meta.forced_tag && (
                <span className="rounded-full border border-brand-border bg-brand-soft px-2 py-0.5 text-[10px] font-semibold tracking-wide text-brand">
                  🏷 #{item.meta.forced_tag}
                </span>
              )}
              {item.meta.handoff && (
                <span className="rounded-full border border-warning-border bg-warning-soft px-2 py-0.5 text-[10px] font-semibold tracking-wide text-warning"
                  title={`Đã tự động chuyển cho cán bộ (${item.meta.handoff.id})`}>
                  ⟶ ĐÃ CHUYỂN CÁN BỘ
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">
                {item.meta.why}
              </span>
            </div>
          )}

          {/* Hỏi lại khi mơ hồ — chip hashtag bấm được */}
          {item.meta?.ask_back && (
            <div className="mb-2 rounded-control border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning">
              <span>
                Câu hỏi hơi mơ hồ — bạn muốn hỏi về chủ đề nào?
              </span>
              <div className="mt-2 flex flex-wrap gap-2">
                {item.meta.ask_back.options.map((o) => (
                  <button
                    key={o}
                    onClick={() => onPickTag?.(o, item.meta!.question)}
                    disabled={pickingDisabled}
                    className="rounded-full border border-warning-border bg-background/60 px-3 py-1 font-mono text-xs text-warning transition hover:bg-warning-soft focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                    title={`Trả lời theo #${o}`}
                  >
                    #{o}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                LLM đang chờ — bấm 1 tag để trả lời đúng chủ đề bạn muốn ↗
              </p>
            </div>
          )}

          {/* Nội dung trả lời / trạng thái */}
          {item.content ? (
            <div className="leading-relaxed whitespace-pre-wrap">{item.content}</div>
          ) : (
            !item.error &&
            !item.done && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="inline-block size-3 animate-spin rounded-full border-2 border-brand border-t-transparent motion-reduce:animate-none" />
                {item.meta ? "Đang sinh câu trả lời..." : "Đang phân tích..."}
              </div>
            )
          )}

          {/* Chờ user chọn hashtag (ASK_BACK — LLM chưa chạy) */}
          {item.done?.skipped_llm &&
            item.meta?.decision === "ASK_BACK" &&
            !item.content && (
              <div className="flex items-center gap-2 text-sm text-warning">
                <span className="inline-block size-2 rounded-full bg-warning" />
                Chưa trả lời — bấm 1 hashtag phía trên để tiếp tục 👆
              </div>
            )}

          {/* Lỗi */}
          {item.error && (
            <div className="text-sm text-destructive">⚠ {item.error}</div>
          )}

          {/* Nguồn + timing */}
          {item.meta && <Sources meta={item.meta} admin={admin} />}
          {item.meta && item.done && <StatsLine meta={item.meta} done={item.done} />}

          {/* Chuyển câu hỏi cho cán bộ — nghiệp vụ 3.0 / D3 */}
          {!item.streaming && question && (
            <div className="mt-3 border-t border-border pt-2.5">
              {transfer === "done" ? (
                <p className="text-[11px] text-brand">
                  ✓ Đã chuyển cho cán bộ tư vấn — cán bộ sẽ trả lời trực tiếp.
                </p>
              ) : transferErr ? (
                <p className="text-[11px] text-destructive">⚠ {transferErr}</p>
              ) : (
                <button
                  onClick={() => void doTransfer()}
                  disabled={transfer === "sending" || pickingDisabled}
                  className="text-[11px] text-muted-foreground underline decoration-border underline-offset-2 transition hover:text-brand focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                >
                  {transfer === "sending"
                    ? "Đang chuyển..."
                    : "⟶ Chuyển câu hỏi cho cán bộ tư vấn"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Đánh giá câu trả lời — nghiệp vụ 4.0 / D4 */}
        {canFeedback && (
          <FeedbackBar
            answerId={answerId!}
            question={item.meta?.question ?? ""}
            answer={item.done?.answer ?? item.content}
            tag={item.meta?.top_tag}
            sources={item.meta?.sources.map((s) => s.id) ?? []}
            disabled={pickingDisabled}
          />
        )}
      </div>
    </div>
  );
}
