"use client";

// components/FeedbackStats.tsx — Admin: tổng hợp đánh giá (nghiệp vụ 6.0)
// Footer strip thu gọn → bấm để mở chi tiết (trung bình theo tag + nhận xét mới)

import { useEffect, useState } from "react";
import { adminFeedbackStats, type FeedbackStats } from "@/lib/api";

export default function FeedbackStats() {
  const [data, setData] = useState<FeedbackStats | null>(null);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    adminFeedbackStats().then((s) => alive && setData(s));
    return () => {
      alive = false;
    };
  }, [tick]);

  if (!data || data.n === 0) return null;

  const pct = Math.round(data.ratio_up * 100);

  return (
    <div className="shrink-0 border-t border-border bg-sidebar">
      {/* strip */}
      <div className="flex min-h-[calc(2.5rem+1px)] items-center gap-3 px-3 py-1.5 sm:px-6">
        <span className="flex items-center gap-1.5 text-xs" title="Điểm trung bình">
          <span className="text-brand" aria-hidden>
            ★
          </span>
          <span className="font-medium tabular-nums">{data.avg_stars}</span>
          <span className="text-muted-foreground">/5</span>
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline tabular-nums">
          {data.n} đánh giá
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline tabular-nums">
          {pct}% hữu ích
        </span>
        {data.with_comment > 0 && (
          <span className="hidden text-xs text-muted-foreground md:inline tabular-nums">
            {data.with_comment} nhận xét
          </span>
        )}

        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-auto flex h-7 items-center gap-1 rounded-control border border-border bg-secondary px-2.5 text-xs text-secondary-foreground transition hover:bg-accent focus-visible:ring-3 motion-reduce:transition-none"
        >
          Đánh giá
          <span aria-hidden className="text-[9px]">
            {open ? "▲" : "▼"}
          </span>
        </button>
        <button
          onClick={() => setTick((t) => t + 1)}
          className="flex size-7 items-center justify-center rounded-control border border-border bg-secondary text-secondary-foreground transition hover:bg-accent focus-visible:ring-3 motion-reduce:transition-none"
          aria-label="Làm mới số liệu"
          title="Làm mới"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
        </button>
      </div>

      {/* chi tiết */}
      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-border px-3 py-4 sm:px-6 scroll-area-thin">
          <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-2">
            {/* theo tag */}
            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground/70">
                Trung bình theo chủ đề
              </h3>
              <ul className="space-y-1.5">
                {data.per_tag.slice(0, 8).map((t) => (
                  <li key={t.tag} className="flex items-center gap-2 text-xs">
                    <span className="w-28 truncate font-mono text-muted-foreground">
                      #{t.tag}
                    </span>
                    <span
                      aria-hidden
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                    >
                      <span
                        className="block h-full rounded-full bg-brand"
                        style={{
                          width: `${Math.max(4, (t.avg_stars / 5) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="w-14 text-right tabular-nums text-muted-foreground">
                      {t.avg_stars} ({t.n})
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* nhận xét mới */}
            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground/70">
                Nhận xét mới nhất
              </h3>
              {data.recent.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Chưa có nhận xét nào.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.recent.map((r, i) => (
                    <li
                      key={i}
                      className="rounded-control border border-border bg-card p-2.5"
                    >
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="text-brand" aria-hidden>
                          {"★".repeat(r.so_sao)}
                          {"☆".repeat(5 - r.so_sao)}
                        </span>
                        {r.tag && <span className="font-mono">#{r.tag}</span>}
                        <span className="ml-auto tabular-nums">
                          {r.created_at.slice(0, 10)}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-foreground">
                        {r.nhan_xet}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        ↳ {r.question}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
