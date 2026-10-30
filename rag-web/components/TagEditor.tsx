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
    <div className="mt-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5">
      <div className="flex items-center gap-2 text-[11px] text-sky-300">
        <span>🏷 Gán tag cho {chunkId}</span>
        {isManual && (
          <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-200">
            tag gán tay
          </span>
        )}
        <span className="ml-auto text-zinc-500">{sel.size} tag đang chọn</span>
      </div>

      {allTags === null && !msg && (
        <p className="mt-2 text-xs text-zinc-500">Đang tải danh sách tag...</p>
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
                    ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
                    : "border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-500"
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
          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "⏳" : "💾 Lưu"}
        </button>
        {isManual && (
          <button
            onClick={reset}
            disabled={busy}
            className="rounded-lg border border-zinc-600 px-3 py-1 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
          >
            ↺ Khôi phục tag rule
          </button>
        )}
        {msg && <span className="text-[11px] text-zinc-400">{msg}</span>}
      </div>
    </div>
  );
}
