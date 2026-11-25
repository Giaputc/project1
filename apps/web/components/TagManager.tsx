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
    <div className="rounded-control border border-input bg-background p-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="rounded-full border border-input bg-muted px-2 py-0.5 text-[11px] text-foreground"
          >
            {v}
            <button
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="ml-1.5 text-muted-foreground hover:text-destructive"
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
          className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <button
          onClick={add}
          className="rounded border border-input px-2 text-xs text-muted-foreground hover:border-input"
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
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded border border-input bg-card">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-brand">
            🏷 Quản lý định nghĩa hashtag (routing input)
          </h2>
          <button
            onClick={onClose}
            className="ml-auto rounded-control border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            ✕ Đóng
          </button>
        </div>

        {/* Tìm kiếm + thêm */}
        <div className="flex gap-2 border-b border-border px-4 py-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm theo id / mô tả..."
            className="flex-1 rounded-control border border-input bg-background px-3 py-1.5 text-xs outline-none focus:border-ring"
          />
          <button
            onClick={() => setAdding(!adding)}
            className="rounded-control bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground hover:opacity-90"
          >
            + Tag mới
          </button>
        </div>

        {/* Thêm tag mới */}
        {adding && (
          <div className="space-y-2 border-b border-border bg-background px-4 py-3">
            <input
              value={newTag.id}
              onChange={(e) =>
                setNewTag({ ...newTag, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })
              }
              placeholder="id (a-z, 0-9, dấu -) vd: nop-phi-khac"
              className="w-full rounded-control border border-input bg-background px-3 py-1.5 font-mono text-xs outline-none focus:border-ring"
            />
            <textarea
              value={newTag.description}
              onChange={(e) => setNewTag({ ...newTag, description: e.target.value })}
              placeholder="Mô tả chủ đề (dùng để embedding so khớp câu hỏi)..."
              rows={2}
              className="w-full resize-none rounded-control border border-input bg-background px-3 py-1.5 text-xs outline-none focus:border-ring"
            />
            <button
              onClick={addTag}
              disabled={busy || !newTag.id.trim() || !newTag.description.trim()}
              className="rounded-control bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground hover:opacity-90 disabled:opacity-40"
            >
              Thêm tag
            </button>
          </div>
        )}

        {msg && (
          <p className="border-b border-border px-4 py-2 text-xs text-foreground">{msg}</p>
        )}

        {/* Danh sách tag */}
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
          {tags === null && <p className="text-xs text-muted-foreground">Đang tải...</p>}
          {shown.map((t) => (
            <div key={t.id} className="rounded-control border border-border bg-background">
              <button
                onClick={() => openTag(t)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
              >
                <span className="font-mono text-brand">#{t.id}</span>
                <span className="truncate text-muted-foreground">{t.description}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                  {t.n_chunks_now} chunk ·{" "}
                  {(t.examples?.length ?? 0) > 0 && `${t.examples!.length} ví dụ`}
                </span>
              </button>

              {openId === t.id && (
                <div className="space-y-2 border-t border-border p-3">
                  <div>
                    <p className="mb-1 text-[11px] text-muted-foreground">
                      Mô tả (embed so khớp câu hỏi):
                    </p>
                    <textarea
                      value={draft.description}
                      onChange={(e) =>
                        setDraft({ ...draft, description: e.target.value })
                      }
                      rows={3}
                      className="w-full resize-none rounded-control border border-input bg-background px-3 py-2 text-xs leading-relaxed outline-none focus:border-ring"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] text-muted-foreground">
                      Từ đồng nghĩa (bổ sung khớp):
                    </p>
                    <ChipInput
                      values={draft.synonyms}
                      onChange={(v) => setDraft({ ...draft, synonyms: v })}
                      placeholder="vd: học phí, tiền học..."
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] text-foreground">
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
                      className="rounded-control bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      💾 Lưu (re-embed + áp dụng)
                    </button>
                    <button
                      onClick={() => delTag(t.id)}
                      disabled={busy}
                      className="rounded-control border border-red-800 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      🗑 Xoá tag
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {tags !== null && shown.length === 0 && (
            <p className="text-xs text-muted-foreground">Không khớp tìm kiếm.</p>
          )}
        </div>

        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground/70">
          Sửa/exemplar → server re-embed mô tả + ví dụ rồi nạp lại corpus — câu hỏi
          sau đã dùng routing mới. Tag mới chưa có chunk nào mang → thêm chunk tay ở
          khung Nguồn.
        </p>
      </div>
    </div>
  );
}
