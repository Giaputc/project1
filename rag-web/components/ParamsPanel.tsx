"use client";

// components/ParamsPanel.tsx — panel chỉnh tham số RAG + trạng thái hệ thống

import { useState } from "react";
import type { Health, RParams } from "@/lib/api";
import { adminRebuild, preheat, reloadCorpus } from "@/lib/api";

interface Props {
  health: Health | null;
  params: RParams;
  onChange: (p: RParams) => void;
  onReset: () => void;
  onClearChat: () => void;
  disabled: boolean;
}

const SECTION_LABEL =
  "flex h-8 items-center px-1 text-xs font-medium text-muted-foreground/70";

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground" title={hint}>
          {label}
        </span>
        <span className="font-mono text-brand">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand"
        aria-label={label}
      />
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  children,
  variant = "quiet",
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: "brand" | "warn" | "quiet";
  title?: string;
}) {
  const cls =
    variant === "brand"
      ? "bg-brand text-brand-foreground hover:opacity-90"
      : variant === "warn"
        ? "border border-warning-border bg-warning-soft text-warning hover:bg-warning-soft/70"
        : "border border-border bg-secondary text-secondary-foreground hover:bg-accent";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`w-full rounded-control px-3 py-2 text-xs font-medium transition focus-visible:ring-3 disabled:opacity-50 motion-reduce:transition-none ${cls}`}
    >
      {children}
    </button>
  );
}

export default function ParamsPanel({
  health,
  params,
  onChange,
  onReset,
  onClearChat,
  disabled,
}: Props) {
  const [preheatState, setPreheatState] = useState<{
    busy: boolean;
    msg: string;
  }>({ busy: false, msg: "" });
  const [reloadState, setReloadState] = useState<{
    busy: boolean;
    msg: string;
  }>({ busy: false, msg: "" });
  const [rebuildState, setRebuildState] = useState<{
    busy: boolean;
    msg: string;
    log?: string;
  }>({ busy: false, msg: "" });

  const set = (patch: Partial<RParams>) => onChange({ ...params, ...patch });

  const handlePreheat = async () => {
    setPreheatState({ busy: true, msg: "Đang nạp model (có thể mất 55–88s)..." });
    try {
      const r = await preheat(params.model ?? undefined);
      setPreheatState({
        busy: false,
        msg: r.ok
          ? `✓ Nạp ${r.model} trong ${r.seconds}s`
          : `✗ ${r.message ?? "Lỗi preheat"}`,
      });
    } catch (e) {
      setPreheatState({ busy: false, msg: `✗ ${String(e)}` });
    }
  };

  const ollama = health?.ollama;
  const models = ollama?.models?.filter((m) => !m.includes("embedding")) ?? [];

  const handleReload = async () => {
    setReloadState({ busy: true, msg: "Đang nạp lại corpus..." });
    try {
      const r = await reloadCorpus();
      setReloadState({
        busy: false,
        msg: r.loaded
          ? `✓ Nạp lại corpus trong ${r.seconds}s — dữ liệu .md mới có hiệu lực`
          : `✗ ${r.error ?? "nạp thất bại"}`,
      });
    } catch (e) {
      setReloadState({ busy: false, msg: `✗ ${String(e)}` });
    }
  };

  const handleRebuild = async () => {
    setRebuildState({ busy: true, msg: "Đang rebuild từ .md (chunk → tag → embed)..." });
    try {
      const r = await adminRebuild();
      if (r.ok) {
        // rebuild.py tự gọi /api/corpus/reload ở cuối → corpus đã mới
        // (health poll 5s của trang chính sẽ cập nhật trạng thái)
        setRebuildState({
          busy: false,
          msg: `✓ Rebuild xong trong ${r.seconds}s — corpus đã cập nhật`,
          log: r.output,
        });
      } else {
        setRebuildState({
          busy: false,
          msg: `✗ ${r.error ?? `rebuild.py exit ${r.returncode}`}`,
          log: r.output,
        });
      }
    } catch (e) {
      setRebuildState({ busy: false, msg: `✗ ${String(e)}` });
    }
  };

  return (
    <div className="flex flex-col gap-4 p-1 text-sm">
      {/* ---- Model ---- */}
      <section className="space-y-2">
        <h2 className={SECTION_LABEL}>Model</h2>
        {models.length > 0 ? (
          <select
            value={params.model ?? ""}
            onChange={(e) => set({ model: e.target.value })}
            className="w-full rounded-control border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-3"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={params.model ?? ""}
            onChange={(e) => set({ model: e.target.value })}
            className="w-full rounded-control border border-input bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus-visible:ring-3"
            aria-label="Tên model"
          />
        )}
        <ActionButton
          onClick={handlePreheat}
          disabled={preheatState.busy || disabled}
          variant="brand"
        >
          {preheatState.busy ? "⏳ Đang nạp..." : "⚡ Nạp model (preheat)"}
        </ActionButton>
        {preheatState.msg && (
          <p className="text-xs break-words text-muted-foreground">
            {preheatState.msg}
          </p>
        )}
        <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={params.use_llm !== false}
            onChange={(e) => set({ use_llm: e.target.checked })}
            className="mt-0.5 accent-brand"
          />
          Gọi LLM trả lời (bỏ tick = chỉ xem tag + nguồn)
        </label>
      </section>

      {/* ---- Tham số RAG ---- */}
      <section className="space-y-3">
        <h2 className={SECTION_LABEL}>Tham số RAG</h2>
        <Slider
          label="temperature"
          value={params.temperature ?? 0.2}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => set({ temperature: v })}
        />
        <Slider
          label="max_tokens"
          value={params.max_tokens ?? 280}
          min={50}
          max={600}
          step={10}
          onChange={(v) => set({ max_tokens: v })}
        />
        <Slider
          label="topk (chunk)"
          value={params.topk ?? 1}
          min={1}
          max={5}
          step={1}
          onChange={(v) => set({ topk: v })}
        />
        <Slider
          label="rrf_k"
          value={params.rrf_k ?? 60}
          min={10}
          max={100}
          step={5}
          onChange={(v) => set({ rrf_k: v })}
          hint="RRF smoothing constant"
        />
        <Slider
          label="tag_boost"
          value={params.tag_boost ?? 1.5}
          min={0}
          max={3}
          step={0.1}
          onChange={(v) => set({ tag_boost: v })}
          hint="boost chunk cùng tag top-1"
        />
        <Slider
          label="margin_ask"
          value={params.margin_ask ?? 0.08}
          min={0}
          max={0.3}
          step={0.01}
          onChange={(v) => set({ margin_ask: v })}
          hint="dưới mức này → hỏi lại (mơ hồ)"
        />
        <Slider
          label="score_low"
          value={params.score_low ?? 0.3}
          min={0}
          max={0.6}
          step={0.05}
          onChange={(v) => set({ score_low: v })}
          hint="dưới mức này → nghi ngoài tài liệu"
        />
      </section>

      {/* ---- Hành động ---- */}
      <section className="space-y-2 border-t border-border pt-3">
        <ActionButton
          onClick={handleRebuild}
          disabled={rebuildState.busy || reloadState.busy || disabled}
          variant="warn"
          title="Chạy rebuild.py: đọc lại file .md → cắt chunk → gắn tag → embed chunk đổi → nạp lại corpus"
        >
          {rebuildState.busy ? "⏳ Đang rebuild (.md → corpus)..." : "▶️ Rebuild từ file .md"}
        </ActionButton>
        {rebuildState.msg && (
          <p className="text-xs break-words text-muted-foreground">
            {rebuildState.msg}
          </p>
        )}
        {rebuildState.log && (
          <details className="rounded-control border border-border bg-background p-2">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              xem log rebuild
            </summary>
            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-[10px] leading-relaxed text-muted-foreground">
              {rebuildState.log}
            </pre>
          </details>
        )}
        <ActionButton
          onClick={handleReload}
          disabled={reloadState.busy || disabled}
        >
          {reloadState.busy ? "⏳ Đang nạp lại..." : "🔄 Nạp lại corpus (sau rebuild)"}
        </ActionButton>
        {reloadState.msg && (
          <p className="text-xs break-words text-muted-foreground">
            {reloadState.msg}
          </p>
        )}
        <ActionButton onClick={onReset}>↺ Về mặc định</ActionButton>
        <ActionButton onClick={onClearChat}>🗑 Xoá lịch sử chat</ActionButton>
      </section>
    </div>
  );
}
