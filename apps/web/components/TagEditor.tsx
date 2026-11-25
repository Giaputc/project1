"use client";

// components/TagEditor.tsx — Admin: gán/bỏ tag cho 1 chunk (ngay trong khung Nguồn)

import { useEffect, useState } from "react";
import {
  adminListTags,
  adminResetChunkTags,
  adminSetChunkTags,
  type AdminTag,
} from "@/lib/api";

interface Props {
  chunkId: string;
  currentTags: string[];
  isManual: boolean;
  onSaved?: (tags: string[], manual: boolean) => void;
}

export default function TagEditor({ chunkId, currentTags, isManual, onSaved }: Props) {
  const [allTags, setAllTags] = useState<AdminTag[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set(currentTags));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    adminListTags()
      .then((tags) => setAllTags(tags))
      .catch((e) => setMsg(`✗ ${String(e)}`));
  }, []);

  const toggle = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMsg(null);
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await adminSetChunkTags(chunkId, [...sel]);
      if (r.ok) {
        setMsg(`✓ Đã lưu ${sel.size} tag — dùng ngay cho retrieve`);
        onSaved?.([...sel], true);
      } else {
        setMsg(`✗ ${r.error}`);
      }
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await adminResetChunkTags(chunkId);
      if (r.ok) {
        setMsg("✓ Đã khôi phục tag rule");
        onSaved?.([], false);
      } else {
        setMsg(`✗ ${r.error}`);
      }
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-control border border-border bg-background/60 p-2.5">
      <div className="flex items-center gap-2 text-[11px] text-brand">
        <span>🏷 Gán tag cho {chunkId}</span>
        {isManual && (
          <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">
            tag gán tay
          </span>
        )}
        <span className="ml-auto text-muted-foreground">{sel.size} tag đang chọn</span>
      </div>

      {allTags === null && !msg && (
        <p className="mt-2 text-xs text-muted-foreground">Đang tải danh sách tag...</p>
      )}

      {allTags && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {allTags.map((t) => {
            const on = sel.has(t.id);
            return (
              <button
                key={t.id}
                onClick={() => toggle(t.id)}
                disabled={busy}
                title={`${t.description.slice(0, 100)}… · ${t.n_chunks_now} chunk`}
                className={`rounded-full border px-2 py-0.5 font-mono text-[11px] transition disabled:opacity-50 ${
                  on
                    ? "border-brand-border bg-brand-soft text-brand"
                    : "border-input bg-card text-muted-foreground hover:border-input"
                }`}
              >
                #{t.id}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-control bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "⏳" : "💾 Lưu"}
        </button>
        {isManual && (
          <button
            onClick={reset}
            disabled={busy}
            className="rounded-control border border-input px-3 py-1 text-xs text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            ↺ Khôi phục tag rule
          </button>
        )}
        {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}
