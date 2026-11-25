"use client";

// components/NotificationBell.tsx — Chuông thông báo (kho THONG_BAO).
// Cán bộ trả lời xong → sinh viên thấy đáp án ở đây; cán bộ thấy câu hỏi mới.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type Notification,
  type NotificationCounts,
} from "@/lib/api";

const TYPE_ICON: Record<Notification["type"], string> = {
  hang_cho_tra_loi: "💬",
  hang_cho_moi: "📥",
  tai_lieu_duyet: "📄",
  tra_loi_duyet: "⭐",
  he_thong: "🔔",
};

const EMPTY_COUNTS: NotificationCounts = { unread: 0, total: 0 };

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [counts, setCounts] = useState<NotificationCounts>(EMPTY_COUNTS);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await listNotifications();
    setItems(r.items);
    setCounts(r.counts);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), 15000);
    return () => {
      clearTimeout(t);
      clearInterval(timer);
    };
  }, [load]);

  // click ngoài → đóng
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const markRead = async (n: Notification) => {
    if (!n.read) {
      await markNotificationRead(n.id);
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setCounts((c) => ({ ...c, unread: Math.max(0, c.unread - 1) }));
    }
  };

  const markAll = async () => {
    await markAllNotificationsRead();
    setItems((prev) => prev.map((x) => ({ ...x, read: true })));
    setCounts((c) => ({ ...c, unread: 0 }));
  };

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Thông báo${counts.unread ? `, ${counts.unread} chưa đọc` : ""}`}
        aria-expanded={open}
        title="Thông báo"
        className="relative flex size-7 items-center justify-center rounded-control text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-3"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {counts.unread > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold leading-4 text-white">
            {counts.unread > 9 ? "9+" : counts.unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-[min(24rem,calc(100vw-2rem))] rounded border border-border bg-card shadow-lg enter-rise">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium">Thông báo</span>
            <span className="text-[11px] text-muted-foreground">
              {counts.unread} chưa đọc
            </span>
            {counts.unread > 0 && (
              <button
                onClick={() => void markAll()}
                className="ml-auto text-[11px] text-brand underline-offset-2 hover:underline focus-visible:ring-3"
              >
                Đọc tất cả
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto scroll-area-thin">
            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                Chưa có thông báo nào.
              </p>
            )}
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => void markRead(n)}
                className={`block w-full border-b border-border/60 px-3 py-2.5 text-left transition hover:bg-accent/60 focus-visible:ring-3 ${
                  n.read ? "" : "bg-brand-soft/40"
                }`}
              >
                <span className="flex items-center gap-2 text-xs font-medium">
                  <span aria-hidden>{TYPE_ICON[n.type]}</span>
                  <span className="min-w-0 flex-1 truncate">{n.title}</span>
                  {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-brand" />}
                </span>
                {n.body && (
                  <span className="mt-1 block whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                    {n.body.length > 320 ? `${n.body.slice(0, 320)}…` : n.body}
                  </span>
                )}
                <span className="mt-1 block text-[10px] text-muted-foreground/60">
                  {n.created_at.replace("T", " ").slice(0, 16)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
