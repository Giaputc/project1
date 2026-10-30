"use client";

// components/TagManager.tsx — Admin: quản lý ĐỊNH NGHĨA tag (routing input)
// Sửa description / synonyms / thêm ví dụ câu hỏi (exemplars) / thêm / xoá tag.

import { useCallback, useEffect, useState } from "react";
import {
  adminAddTag,
  adminDeleteTag,
  adminListTags,
  adminUpdateTag,
  type AdminTag,
} from "@/lib/api";

interface Props {
  onClose: () => void;
}

/** Editor chip-list: nhập rồi Enter → thêm chip */
function ChipInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="rounded-full border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300"
          >
            {v}
            <button
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="ml-1.5 text-zinc-500 hover:text-red-400"
              title="Xoá"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-xs text-zinc-200 outline-none placeholder-zinc-600"
        />
        <button
          onClick={add}
          className="rounded border border-zinc-700 px-2 text-xs text-zinc-400 hover:border-zinc-500"
        >
          + thêm
        </button>
      </div>
    </div>
  );
}

export default function TagManager({ onClose }: Props) {
  const [tags, setTags] = useState<AdminTag[] | null>(null);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    description: string;
    synonyms: string[];
    examples: string[];
  }>({ description: "", synonyms: [], examples: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTag, setNewTag] = useState({ id: "", description: "" });

  const reload = useCallback(() => {
    adminListTags()
      .then(setTags)
      .catch((e) => setMsg(`✗ ${String(e)}`));
  }, []);
  useEffect(reload, [reload]);

  const openTag = (t: AdminTag) => {
    if (openId === t.id) {
      setOpenId(null);
      return;
    }
    setOpenId(t.id);
    setDraft({
      description: t.description,
      synonyms: [...t.synonyms],
      examples: [...(t.examples ?? [])],
    });
    setMsg(null);
  };

  const saveTag = async (id: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await adminUpdateTag(id, draft);
      if (r.ok) {
        setMsg(`✓ Đã cập nhật #${id} — routing áp dụng ngay`);
        reload();
      } else setMsg(`✗ ${r.error}`);
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const delTag = async (id: string) => {
    if (!confirm(`Xoá tag #${id}? Sẽ gỡ khỏi mọi chunk đang gán tay.`)) return;
    setBusy(true);
    try {
      const r = await adminDeleteTag(id);
      setMsg(r.ok ? `✓ Đã xoá #${id}` : `✗ ${r.error}`);
      setOpenId(null);
      reload();
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const addTag = async () => {
    if (!newTag.id.trim() || !newTag.description.trim()) return;
    setBusy(true);
    try {
      const r = await adminAddTag({
        id: newTag.id.trim(),
        description: newTag.description.trim(),
      });
      if (r.ok) {
        setMsg(`✓ Đã thêm #${newTag.id} — thêm chunk + ví dụ để routing hoạt động`);
        setAdding(false);
        setNewTag({ id: "", description: "" });
        reload();
      } else setMsg(`✗ ${r.error}`);
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const shown = (tags ?? []).filter(
    (t) =>
      !q ||
      t.id.includes(q.toLowerCase()) ||
      t.description.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-700 bg-zinc-900">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-emerald-400">
            🏷 Quản lý định nghĩa hashtag (routing input)
          </h2>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            ✕ Đóng
          </button>
        </div>

        {/* Tìm kiếm + thêm */}
        <div className="flex gap-2 border-b border-zinc-800 px-4 py-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm theo id / mô tả..."
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs outline-none focus:border-emerald-600"
          />
          <button
            onClick={() => setAdding(!adding)}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            + Tag mới
          </button>
        </div>

        {/* Thêm tag mới */}
        {adding && (
          <div className="space-y-2 border-b border-zinc-800 bg-zinc-950/50 px-4 py-3">
            <input
              value={newTag.id}
              onChange={(e) =>
                setNewTag({ ...newTag, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })
              }
              placeholder="id (a-z, 0-9, dấu -) vd: nop-phi-khac"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs outline-none focus:border-emerald-600"
            />
            <textarea
              value={newTag.description}
              onChange={(e) => setNewTag({ ...newTag, description: e.target.value })}
              placeholder="Mô tả chủ đề (dùng để embedding so khớp câu hỏi)..."
              rows={2}
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs outline-none focus:border-emerald-600"
            />
            <button
              onClick={addTag}
              disabled={busy || !newTag.id.trim() || !newTag.description.trim()}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Thêm tag
            </button>
          </div>
        )}

        {msg && (
          <p className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-300">{msg}</p>
        )}

        {/* Danh sách tag */}
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
          {tags === null && <p className="text-xs text-zinc-500">Đang tải...</p>}
          {shown.map((t) => (
            <div key={t.id} className="rounded-xl border border-zinc-800 bg-zinc-950/60">
              <button
                onClick={() => openTag(t)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
              >
                <span className="font-mono text-emerald-400">#{t.id}</span>
                <span className="truncate text-zinc-400">{t.description}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                  {t.n_chunks_now} chunk ·{" "}
                  {(t.examples?.length ?? 0) > 0 && `${t.examples!.length} ví dụ`}
                </span>
              </button>

              {openId === t.id && (
                <div className="space-y-2 border-t border-zinc-800 p-3">
                  <div>
                    <p className="mb-1 text-[11px] text-zinc-500">
                      Mô tả (embed so khớp câu hỏi):
                    </p>
                    <textarea
                      value={draft.description}
                      onChange={(e) =>
                        setDraft({ ...draft, description: e.target.value })
                      }
                      rows={3}
                      className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs leading-relaxed outline-none focus:border-emerald-600"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] text-zinc-500">
                      Từ đồng nghĩa (bổ sung khớp):
                    </p>
                    <ChipInput
                      values={draft.synonyms}
                      onChange={(v) => setDraft({ ...draft, synonyms: v })}
                      placeholder="vd: học phí, tiền học..."
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] text-zinc-300">
                      ✨ Câu ví dụ (exemplar — routing mạnh nhất):
                    </p>
                    <ChipInput
                      values={draft.examples}
                      onChange={(v) => setDraft({ ...draft, examples: v })}
                      placeholder="vd: Học phí kỳ này bao nhiêu?"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveTag(t.id)}
                      disabled={busy}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      💾 Lưu (re-embed + áp dụng)
                    </button>
                    <button
                      onClick={() => delTag(t.id)}
                      disabled={busy}
                      className="rounded-lg border border-red-800 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      🗑 Xoá tag
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {tags !== null && shown.length === 0 && (
            <p className="text-xs text-zinc-500">Không khớp tìm kiếm.</p>
          )}
        </div>

        <p className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-600">
          Sửa/exemplar → server re-embed mô tả + ví dụ rồi nạp lại corpus — câu hỏi
          sau đã dùng routing mới. Tag mới chưa có chunk nào mang → thêm chunk tay ở
          khung Nguồn.
        </p>
      </div>
    </div>
  );
}
