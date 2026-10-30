"use client";

// components/ChatMessage.tsx — 1 cặp tin nhắn (user / assistant) trong chat

import { useState } from "react";
import type { DoneEvent, MetaEvent } from "@/lib/api";
import TagEditor from "@/components/TagEditor";

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;             // text trả lời (streaming dần)
  meta?: MetaEvent;
  done?: DoneEvent;
  error?: string;
  streaming?: boolean;
}

const DECISION_STYLE: Record<string, { label: string; cls: string }> = {
  ANSWER: {
    label: "✓ TRẢ LỜI",
    cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  ASK_BACK: {
    label: "? HỎI LẠI",
    cls: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  },
  OUT_OF_SCOPE: {
    label: "✕ NGOÀI TÀI LIỆU",
    cls: "bg-red-500/15 text-red-400 border-red-500/30",
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
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-400 transition hover:text-zinc-200"
      >
        <span>
          📄 Nguồn [{meta.sources.map((s) => `T${s.rank}`).join(", ")}]
        </span>
        <span className="ml-auto text-zinc-600">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-zinc-800 p-3">
          {meta.sources.map((s) => {
            const tags = localTags[s.id] ?? s.tags;
            const manual = localManual[s.id] ?? false;
            return (
              <details
                key={s.id + s.rank}
                className="rounded-lg bg-zinc-950/60 p-2.5 text-xs"
              >
                <summary className="cursor-pointer list-none">
                  <span className="font-mono text-emerald-400">[T{s.rank}]</span>{" "}
                  <span className="font-mono text-zinc-500">{s.id}</span>
                  <span className="text-zinc-500">
                    {" "}
                    · tr.{s.page_start}
                    {s.page_end !== s.page_start ? `-${s.page_end}` : ""}
                  </span>
                  {tags.map((t) => (
                    <span
                      key={t}
                      className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                        manual && t === tags[0]
                          ? "bg-sky-500/20 text-sky-300"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      #{t}
                    </span>
                  ))}
                  <span className="mt-1 block text-zinc-300">{s.heading}</span>
                </summary>
                <p className="mt-2 whitespace-pre-wrap border-l-2 border-emerald-800 pl-2 leading-relaxed text-zinc-400">
                  {s.text}
                </p>
                {admin && (
                  <>
                    <button
                      onClick={() => setEditId(editId === s.id ? null : s.id)}
                      className="mt-2 rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-sky-600 hover:text-sky-300"
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
            <p className="text-[11px] text-zinc-600">
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
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-600">
      <span>tag #{meta.top_tag}</span>
      <span>· {meta.elapsed_s}s (pipeline)</span>
      {s && (
        <>
          {s.cold_start && <span className="text-amber-500">· cold start ⚠</span>}
          <span>
            · prompt {s.prompt_ms?.toFixed(0)}ms ({s.prompt_tokens} tok
            {s.prompt_cached ? `, cache ${s.prompt_cached}` : ""})
          </span>
          <span>
            · sinh {s.gen_ms?.toFixed(0)}ms ({s.out_tokens} tok)
          </span>
          {s.truncated && (
            <span className="text-amber-500">· chạm trần max_tokens ⚠</span>
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
}

export default function ChatMessage({ item, onPickTag, pickingDisabled, admin }: Props) {
  const isUser = item.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-emerald-600 px-4 py-2.5 text-sm text-white whitespace-pre-wrap">
          {item.content}
        </div>
      </div>
    );
  }

  const dec = item.meta ? DECISION_STYLE[item.meta.decision] : null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] space-y-1">
        <div className="rounded-2xl rounded-bl-md border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-200">
          {/* Decision badge + why */}
          {item.meta && dec && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${dec.cls}`}
              >
                {dec.label}
              </span>
              {item.meta.forced_tag && (
                <span className="rounded-full border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-sky-400">
                  🏷 #{item.meta.forced_tag}
                </span>
              )}
              <span className="text-[11px] text-zinc-500">{item.meta.why}</span>
            </div>
          )}

          {/* Hỏi lại khi mơ hồ — chip hashtag bấm được */}
          {item.meta?.ask_back && (
            <div className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <span>
                Câu hỏi hơi mơ hồ — bạn muốn hỏi về chủ đề nào?
              </span>
              <div className="mt-2 flex flex-wrap gap-2">
                {item.meta.ask_back.options.map((o) => (
                  <button
                    key={o}
                    onClick={() => onPickTag?.(o, item.meta!.question)}
                    disabled={pickingDisabled}
                    className="rounded-full border border-amber-500/50 bg-amber-500/15 px-3 py-1 font-mono text-xs text-amber-200 transition hover:border-amber-400 hover:bg-amber-500/30 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                    title={`Trả lời theo #${o}`}
                  >
                    #{o}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-amber-400/70">
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
              <div className="flex items-center gap-2 text-zinc-500">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                {item.meta ? "Đang sinh câu trả lời..." : "Đang phân tích..."}
              </div>
            )
          )}

          {/* Chờ user chọn hashtag (ASK_BACK — LLM chưa chạy) */}
          {item.done?.skipped_llm &&
            item.meta?.decision === "ASK_BACK" &&
            !item.content && (
              <div className="flex items-center gap-2 text-sm text-amber-300">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                Chưa trả lời — bấm 1 hashtag phía trên để tiếp tục 👆
              </div>
            )}

          {/* Lỗi */}
          {item.error && (
            <div className="text-sm text-red-400">⚠ {item.error}</div>
          )}

          {/* Nguồn + timing */}
          {item.meta && <Sources meta={item.meta} admin={admin} />}
          {item.meta && item.done && <StatsLine meta={item.meta} done={item.done} />}
        </div>
      </div>
    </div>
  );
}
