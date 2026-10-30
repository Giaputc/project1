// lib/api.ts — client gọi FastAPI (rag_api) + parser SSE

export interface RParams {
  model?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  topk?: number | null;
  rrf_k?: number | null;
  tag_boost?: number | null;
  margin_ask?: number | null;
  score_low?: number | null;
  keep_alive?: string | null;
  use_llm?: boolean | null;
}

export interface TagScore {
  tag: string;
  score: number;
}

export interface Source {
  rank: number;
  id: string;
  page_start: number;
  page_end: number;
  tags: string[];
  tag_primary: string | null;
  heading: string;
  rrf: number;
  text: string;
}

export interface MetaEvent {
  type: "meta";
  question: string;
  decision: "ANSWER" | "ASK_BACK" | "OUT_OF_SCOPE";
  why: string;
  top_tag: string;
  forced_tag: string | null;
  scores: TagScore[];
  ask_back: { question: string; options: string[] } | null;
  sources: Source[];
  global_fallback: string[];
  prompt: string;
  system_prompt: string;
  params: Record<string, unknown>;
  elapsed_s: number;
}

export interface DoneEvent {
  type: "done";
  answer: string | null;
  stats: {
    load_ms?: number;
    prompt_tokens?: number;
    prompt_cached?: number;
    prompt_ms?: number;
    out_tokens?: number;
    gen_ms?: number;
    cold_start?: boolean;
    truncated?: boolean;
  } | null;
  elapsed_s: number;
  skipped_llm: boolean;
  reason?: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface TokenEvent {
  type: "token";
  text: string;
}

export type StreamEvent = MetaEvent | TokenEvent | DoneEvent | ErrorEvent;

export interface Health {
  ollama: { ok: boolean; url: string; models: string[]; error: string | null };
  corpus: { loaded: boolean; error: string | null; loading: boolean };
  defaults: RParams;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ===============================================================
// PHIÊN ĐĂNG NHẬP (localStorage)
// ===============================================================
export interface Session {
  token: string;
  role: "admin" | "guest";
  display: string;
}

const SESSION_KEY = "rag_session";

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(s: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

function authHeaders(): Record<string, string> {
  const s = getSession();
  return s ? { Authorization: `Bearer ${s.token}` } : {};
}

// ---- Auth API ----
export async function login(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string } & Partial<Session>> {
  const r = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return r.json();
}

export async function guestLogin(): Promise<{ ok: boolean } & Partial<Session>> {
  const r = await fetch(`${API_URL}/api/auth/guest`, { method: "POST" });
  return r.json();
}

// ---- Admin API ----
export interface AdminTag {
  id: string;
  hashtag: string;
  description: string;
  synonyms: string[];
  examples?: string[];
  n_chunks_rule: number;
  n_chunks_now: number;
}

export interface AdminChunk {
  id: string;
  page_start: number;
  page_end: number;
  heading: string;
  tags: string[];
  tags_rule: string[];
  tags_manual: boolean;
  text_preview: string;
}

interface AdminResponse {
  ok: boolean;
  error?: string;
  detail?: string;
  tags?: AdminTag[];
  chunks?: AdminChunk[];
}

async function adminFetch(path: string, init?: RequestInit): Promise<AdminResponse> {
  const r = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (r.status === 401 || r.status === 403) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail ?? (r.status === 401 ? "Hết phiên đăng nhập" : "Chỉ admin mới có quyền"));
  }
  return r.json();
}

export async function adminListTags(): Promise<AdminTag[]> {
  const r = await adminFetch("/api/admin/tags");
  return r.tags ?? [];
}

export async function adminUpdateTag(
  tagId: string,
  patch: { description?: string; synonyms?: string[]; examples?: string[] },
): Promise<{ ok: boolean; error?: string }> {
  return adminFetch(`/api/admin/tags/${tagId}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function adminAddTag(body: {
  id: string;
  description: string;
  synonyms?: string[];
  examples?: string[];
}): Promise<{ ok: boolean; error?: string }> {
  return adminFetch("/api/admin/tags", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function adminDeleteTag(tagId: string): Promise<{ ok: boolean; error?: string }> {
  return adminFetch(`/api/admin/tags/${tagId}`, { method: "DELETE" });
}

export async function adminListChunks(q?: string, limit = 300): Promise<AdminChunk[]> {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  qs.set("limit", String(limit));
  const r = await adminFetch(`/api/admin/chunks?${qs}`);
  return r.chunks ?? [];
}

export async function adminSetChunkTags(
  chunkId: string,
  tags: string[],
): Promise<{ ok: boolean; error?: string }> {
  return adminFetch(`/api/admin/chunks/${chunkId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags }),
  });
}

export async function adminResetChunkTags(
  chunkId: string,
): Promise<{ ok: boolean; error?: string }> {
  return adminFetch(`/api/admin/chunks/${chunkId}/tags`, { method: "DELETE" });
}

/** Chạy rebuild.py từ .md (chunk → tag → embed → reload) — admin */
export async function adminRebuild(): Promise<{
  ok: boolean;
  error?: string;
  seconds?: number;
  returncode?: number;
  output?: string;
}> {
  return adminFetch("/api/admin/rebuild", { method: "POST" });
}

// ===============================================================
// Health / Preheat / Reload
// ===============================================================
export async function fetchHealth(): Promise<Health> {
  const r = await fetch(`${API_URL}/health`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function preheat(model?: string): Promise<{
  ok: boolean;
  seconds?: number;
  message?: string;
  model?: string;
}> {
  const r = await fetch(`${API_URL}/api/preheat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ model: model ?? null }),
  });
  if (r.status === 401 || r.status === 403) {
    return { ok: false, message: "Chỉ admin mới được nạp model" };
  }
  return r.json();
}

/** Nạp lại corpus + embed cache từ backend (gọi sau khi chạy rebuild.py) — admin */
export async function reloadCorpus(): Promise<{
  loaded: boolean;
  error: string | null;
  seconds?: number;
}> {
  const r = await fetch(`${API_URL}/api/corpus/reload`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Gọi /api/ask/stream (SSE qua POST) — trả về async generator các event.
 * Khi abort (AbortController), stream đóng lại.
 */
export async function* askStream(
  question: string,
  params: RParams,
  signal?: AbortSignal,
  forceTag?: string | null,
): AsyncGenerator<StreamEvent> {
  const r = await fetch(`${API_URL}/api/ask/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ question, params, force_tag: forceTag ?? null }),
    signal,
  });
  if (!r.ok || !r.body) {
    throw new Error(`Backend lỗi: HTTP ${r.status}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events cách nhau bằng dòng trống
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let eventName = "message";
      let dataLine = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine);
        payload.type = payload.type ?? eventName;
        yield payload as StreamEvent;
      } catch {
        // bỏ qua dòng hỏng
      }
    }
  }
}
