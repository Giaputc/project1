"use client";

// components/ParamsPanel.tsx — panel chỉnh tham số RAG + trạng thái hệ thống

import { useState } from "react";
import type { Health, RParams } from "@/lib/api";
import { adminRebuild, preheat, reloadCorpus } from "@/lib/api";

interface Props {
  health: Health | null;
  healthError: string | null;
  params: RParams;
  onChange: (p: RParams) => void;
  onReset: () => void;
  onClearChat: () => void;
  disabled: boolean;
}

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
        <span className="text-zinc-400" title={hint}>
          {label}
        </span>
        <span className="font-mono text-emerald-400">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-500"
      />
    </div>
  );
}

export default function ParamsPanel({
  health,
  healthError,
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
  const corpus = health?.corpus;
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
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4 text-sm">
      {/* ---- Trạng thái ---- */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold tracking-widest text-zinc-500 uppercase">
          Hệ thống
        </h2>
        <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                ollama?.ok ? "bg-emerald-500" : "bg-red-500"
              }`}
            />
            <span className="text-zinc-300">Ollama</span>
            <span className="ml-auto text-xs text-zinc-500">
              {ollama?.ok ? "online" : healthError ? "backend?" : "offline"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                corpus?.loaded
                  ? "bg-emerald-500"
                  : corpus?.error
                    ? "bg-red-500"
                    : "bg-amber-500 animate-pulse"
              }`}
            />
            <span className="text-zinc-300">Corpus</span>
            <span className="ml-auto text-xs text-zinc-500">
              {corpus?.loaded
                ? "158 chunks ✓"
                : corpus?.error
                  ? "lỗi nạp"
                  : "đang nạp..."}
            </span>
          </div>
          {corpus?.error && (
            <p className="text-xs text-red-400">{corpus.error}</p>
          )}
          {healthError && (
            <p className="text-xs text-red-400">{healthError}</p>
          )}
        </div>
      </section>

      {/* ---- Model ---- */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold tracking-widest text-zinc-500 uppercase">
          Model
        </h2>
        {models.length > 0 ? (
          <select
            value={params.model ?? ""}
            onChange={(e) => set({ model: e.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-200"
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
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 font-mono text-xs text-zinc-200"
          />
        )}
        <button
          onClick={handlePreheat}
          disabled={preheatState.busy || disabled}
          className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {preheatState.busy ? "⏳ Đang nạp..." : "⚡ Nạp model (preheat)"}
        </button>
        {preheatState.msg && (
          <p className="text-xs break-words text-zinc-400">{preheatState.msg}</p>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={params.use_llm !== false}
            onChange={(e) => set({ use_llm: e.target.checked })}
            className="accent-emerald-500"
          />
          Gọi LLM trả lời (bỏ tick = chỉ xem tag + nguồn)
        </label>
      </section>

      {/* ---- Tham số RAG ---- */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold tracking-widest text-zinc-500 uppercase">
          Tham số RAG
        </h2>
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
      <section className="space-y-2 border-t border-zinc-800 pt-3">
        <button
          onClick={handleRebuild}
          disabled={rebuildState.busy || reloadState.busy || disabled}
          className="w-full rounded-lg border border-amber-600 bg-amber-900/30 px-3 py-2 text-xs font-semibold text-amber-300 transition hover:bg-amber-800/50 disabled:opacity-50"
          title="Chạy rebuild.py: đọc lại file .md → cắt chunk → gắn tag → embed chunk đổi → nạp lại corpus"
        >
          {rebuildState.busy ? "⏳ Đang rebuild (.md → corpus)..." : "▶️ Rebuild từ file .md"}
        </button>
        {rebuildState.msg && (
          <p className="text-xs break-words text-zinc-400">{rebuildState.msg}</p>
        )}
        {rebuildState.log && (
          <details className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
            <summary className="cursor-pointer text-[11px] text-zinc-500">
              xem log rebuild
            </summary>
            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-[10px] leading-relaxed text-zinc-500">
              {rebuildState.log}
            </pre>
          </details>
        )}
        <button
          onClick={handleReload}
          disabled={reloadState.busy || disabled}
          className="w-full rounded-lg border border-sky-700 bg-sky-900/30 px-3 py-2 text-xs text-sky-300 transition hover:bg-sky-800/50 disabled:opacity-50"
        >
          {reloadState.busy ? "⏳ Đang nạp lại..." : "🔄 Nạp lại corpus (sau khi rebuild.py)"}
        </button>
        {reloadState.msg && (
          <p className="text-xs break-words text-zinc-400">{reloadState.msg}</p>
        )}
        <button
          onClick={onReset}
          className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 transition hover:bg-zinc-800"
        >
          ↺ Về mặc định
        </button>
        <button
          onClick={onClearChat}
          className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 transition hover:bg-zinc-800"
        >
          🗑 Xoá lịch sử chat
        </button>
      </section>
    </div>
  );
}
