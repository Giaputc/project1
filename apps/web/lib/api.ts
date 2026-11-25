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
  answer_id?: string;
  question: string;
  decision: "ANSWER" | "ASK_BACK" | "OUT_OF_SCOPE";
  why: string;
  top_tag: string;
  forced_tag: string | null;
  scores: TagScore[];
  ask_back: { question: string; options: string[] } | null;
  sources: Source[];
  global_fallback: string[];
  /** AI tự động chuyển câu hỏi này cho cán bộ (độ tin cậy thấp / lỗi) */
  handoff?: { id: string; status: string } | null;
  prompt: string;
  system_prompt: string;
  params: Record<string, unknown>;
  elapsed_s: number;
}

export interface DoneEvent {
  type: "done";
  answer_id?: string;
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
  /** Khóa danh tính: admin/canbo/sinh_vien = username, guest = khach_<guest_id> */
  username: string;
  role: "admin" | "can_bo" | "sinh_vien" | "guest";
  display: string;
}

const SESSION_KEY = "rag_session";
const GUEST_ID_KEY = "rag_guest_id";
const CHAT_KEY_PREFIX = "rag_chat_";

/** id khách riêng cho từng browser — tách lịch sử/thông báo, không dùng chung `khach`. */
export function getOrCreateGuestId(): string {
  if (typeof window === "undefined") return "server";
  try {
    let id = localStorage.getItem(GUEST_ID_KEY) ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(GUEST_ID_KEY, id);
    }
    return id;
  } catch {
    return `g${Date.now().toString(36)}`;
  }
}

/** Phiên chat đang mở, lưu riêng theo từng danh tính. */
export function readActiveSid(username: string): string {
  if (typeof window === "undefined" || !username) return "";
  try {
    return localStorage.getItem(`${CHAT_KEY_PREFIX}${username}`) ?? "";
  } catch {
    return "";
  }
}

export function saveActiveSid(username: string, sid: string): void {
  if (typeof window === "undefined" || !username || !sid) return;
  try {
    localStorage.setItem(`${CHAT_KEY_PREFIX}${username}`, sid);
  } catch {
    /* localStorage đầy — bỏ qua, lịch sử vẫn nằm ở server */
  }
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    // Session cũ (trước khi tách riêng) không có username → bắt đăng nhập lại
    return parsed.username ? parsed : null;
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
  const r = await fetch(`${API_URL}/api/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guest_id: getOrCreateGuestId() }),
  });
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

// ===============================================================
// FEEDBACK — Đánh giá câu trả lời (nghiệp vụ 4.0 / D4)
// ===============================================================
export interface FeedbackInput {
  answer_id: string;
  question: string;
  vote: "up" | "down";
  so_sao: number;
  nhan_xet?: string | null;
  answer_preview?: string | null;
  answer?: string | null;
  tag?: string | null;
  sources?: string[];
}

/** Feedback đầy đủ — cán bộ dùng để xem sao/nhận xét của sinh viên */
export interface FeedbackItem {
  id: string;
  answer_id: string;
  question: string;
  answer_preview?: string | null;
  answer?: string | null;
  vote: "up" | "down";
  so_sao: number;
  nhan_xet?: string | null;
  tag?: string | null;
  user?: string | null;
  display?: string | null;
  role?: string | null;
  created_at: string;
}

export async function listFeedbackItems(limit = 200): Promise<FeedbackItem[]> {
  try {
    const r = await authedFetch<{ items: FeedbackItem[] }>(`/api/feedback/items?limit=${limit}`);
    return r.items ?? [];
  } catch {
    return [];
  }
}

export async function feedbackToReview(feedbackId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    return await authedFetch(`/api/feedback/${feedbackId}/to-review`, { method: "POST" });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface FeedbackStats {
  n: number;
  avg_stars: number;
  up: number;
  down: number;
  ratio_up: number;
  with_comment: number;
  per_tag: { tag: string; n: number; avg_stars: number }[];
  recent: {
    question: string;
    so_sao: number;
    vote: string;
    nhan_xet: string | null;
    tag: string | null;
    created_at: string;
  }[];
}

/** Gửi đánh giá — khách và admin đều gửi được */
export async function submitFeedback(
  body: FeedbackInput,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${API_URL}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false }));
    if (!r.ok) {
      return { ok: false, error: j.detail ?? `HTTP ${r.status}` };
    }
    return { ok: !!j.ok, error: j.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Tổng hợp đánh giá — admin */
export async function adminFeedbackStats(): Promise<FeedbackStats | null> {
  try {
    const r = await adminFetch("/api/feedback/stats");
    if (!r.ok) return null;
    return (r as { stats?: FeedbackStats }).stats ?? null;
  } catch {
    return null;
  }
}

// ===============================================================
// HISTORY — Lịch sử câu hỏi (nghiệp vụ 1.0 / D1)
// ===============================================================
export interface HistorySession {
  session_id: string;
  preview: string;
  n_messages: number;
  updated_at: string;
}

/** Ghi 1 tin nhắn (upsert theo item.id) — lỗi lặng để chat không vỡ */
export async function saveHistoryItem(
  sessionId: string,
  item: ChatItemLike,
): Promise<void> {
  try {
    await fetch(`${API_URL}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ session_id: sessionId, item }),
    });
  } catch {
    /* lịch sử phụ trợ — không chặn chat */
  }
}

export async function listHistorySessions(
  limit = 50,
): Promise<HistorySession[]> {
  try {
    const r = await fetch(`${API_URL}/api/history/sessions?limit=${limit}`, {
      headers: authHeaders(),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.sessions ?? []) as HistorySession[];
  } catch {
    return [];
  }
}

export async function loadHistorySession(
  sessionId: string,
): Promise<ChatItemLike[]> {
  try {
    const r = await fetch(
      `${API_URL}/api/history/${encodeURIComponent(sessionId)}`,
      { headers: authHeaders() },
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j.items ?? []) as ChatItemLike[];
  } catch {
    return [];
  }
}

export async function deleteHistorySession(
  sessionId: string,
): Promise<number> {
  try {
    const r = await fetch(
      `${API_URL}/api/history/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", headers: authHeaders() },
    );
    if (!r.ok) return 0;
    const j = await r.json();
    return (j.removed as number) ?? 0;
  } catch {
    return 0;
  }
}

/** Shape tối thiểu của 1 tin nhắn để lưu/đọc lịch sử */
export interface ChatItemLike {
  id: string;
  role: "user" | "assistant";
  content: string;
  question?: string;
  meta?: MetaEvent;
  done?: DoneEvent;
  error?: string;
}

// ===============================================================
// HÀNG CHỜ CÁN BỘ (nghiệp vụ 3.0 / D3)
// ===============================================================
export interface HangChoItem {
  id: string;
  question: string;
  user: string | null;
  display: string | null;
  answer_id: string | null;
  tag: string | null;
  reason: string | null;
  ai_answer: string | null;
  status: "cho_xu_ly" | "da_tra_loi";
  reply: string | null;
  replied_by: string | null;
  replied_at: string | null;
  created_at: string;
}

export interface HangChoCounts {
  cho_xu_ly: number;
  da_tra_loi: number;
  tong: number;
}

export async function addHangCho(body: {
  question: string;
  answer_id?: string | null;
  tag?: string | null;
  reason?: string | null;
  ai_answer?: string | null;
}): Promise<{ ok: boolean; error?: string; item?: HangChoItem }> {
  try {
    const r = await fetch(`${API_URL}/api/hangcho`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.ok, error: j.error ?? j.detail, item: j.item };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listHangCho(
  status?: "cho_xu_ly" | "da_tra_loi",
): Promise<{ items: HangChoItem[]; counts: HangChoCounts }> {
  try {
    const qs = status ? `?status=${status}` : "";
    const r = await fetch(`${API_URL}/api/hangcho${qs}`, {
      headers: authHeaders(),
    });
    if (r.status === 401 || r.status === 403) return { items: [], counts: { cho_xu_ly: 0, da_tra_loi: 0, tong: 0 } };
    const j = await r.json();
    return { items: j.items ?? [], counts: j.counts ?? { cho_xu_ly: 0, da_tra_loi: 0, tong: 0 } };
  } catch {
    return { items: [], counts: { cho_xu_ly: 0, da_tra_loi: 0, tong: 0 } };
  }
}

export async function replyHangCho(
  id: string,
  reply: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${API_URL}/api/hangcho/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ reply }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: "Chỉ cán bộ tư vấn hoặc admin mới trả lời được" };
    }
    if (r.status === 404) return { ok: false, error: "Không còn câu hỏi này" };
    return { ok: !!j.ok, error: j.error ?? j.detail };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
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

// ===============================================================
// THÔNG BÁO (nghiệp vụ 3.0/4.0 — THONG_BAO)
// ===============================================================
export interface Notification {
  id: string;
  user: string;
  type: "hang_cho_tra_loi" | "hang_cho_moi" | "tai_lieu_duyet" | "tra_loi_duyet" | "danh_gia_moi" | "he_thong";
  title: string;
  body: string;
  ref_id: string | null;
  read: boolean;
  created_at: string;
}

export interface NotificationCounts {
  unread: number;
  total: number;
}

async function authedFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? j.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export async function listNotifications(
  unreadOnly = false,
): Promise<{ items: Notification[]; counts: NotificationCounts }> {
  try {
    const r = await authedFetch<{ items: Notification[]; counts: NotificationCounts }>(
      `/api/notifications?unread_only=${unreadOnly}`,
    );
    return { items: r.items ?? [], counts: r.counts ?? { unread: 0, total: 0 } };
  } catch {
    return { items: [], counts: { unread: 0, total: 0 } };
  }
}

export async function markNotificationRead(id: string): Promise<void> {
  try {
    await authedFetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: "POST",
    });
  } catch {
    /* thông báo phụ trợ */
  }
}

export async function markAllNotificationsRead(): Promise<void> {
  try {
    await authedFetch("/api/notifications/read-all", { method: "POST" });
  } catch {
    /* thông báo phụ trợ */
  }
}

// ===============================================================
// TRI THỨC — đề xuất & phê duyệt tài liệu (D3 → D2)
// ===============================================================
export interface KnowledgeEntry {
  id: string;
  kind: "tai_lieu" | "tra_loi";
  title: string;
  text: string;
  tag: string | null;
  source: string | null;
  proposed_by: string | null;
  proposed_display: string | null;
  status: "de_xuat" | "da_duyet" | "tu_choi";
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface KnowledgeCounts {
  de_xuat: number;
  da_duyet: number;
  tu_choi: number;
  tong: number;
}

export interface KnowledgeResult {
  ok: boolean;
  error?: string;
  item?: KnowledgeEntry;
  reload?: { loaded: boolean; error: string | null };
}

export async function proposeDoc(body: {
  title: string;
  text: string;
  tag?: string | null;
  source?: string | null;
}): Promise<KnowledgeResult> {
  try {
    return await authedFetch("/api/knowledge", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listKnowledge(status?: string): Promise<{
  items: KnowledgeEntry[];
  counts: KnowledgeCounts;
}> {
  try {
    const qs = status ? `?status=${status}` : "";
    const r = await authedFetch<{ items: KnowledgeEntry[]; counts: KnowledgeCounts }>(
      `/api/knowledge${qs}`,
    );
    return { items: r.items ?? [], counts: r.counts ?? { de_xuat: 0, da_duyet: 0, tu_choi: 0, tong: 0 } };
  } catch {
    return { items: [], counts: { de_xuat: 0, da_duyet: 0, tu_choi: 0, tong: 0 } };
  }
}

export async function reviewDoc(
  id: string,
  action: "duyet" | "tu_choi",
  note?: string,
): Promise<KnowledgeResult> {
  try {
    return await authedFetch(`/api/knowledge/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ action, note: note ?? null }),
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ===============================================================
// RÀ SOÁT CÂU TRẢ LỜI (D4 → tri thức)
// ===============================================================
export interface ReviewItem {
  id: string;
  answer_id: string | null;
  feedback_id?: string | null;
  question: string;
  answer: string;
  final_answer: string | null;
  tag: string | null;
  status: "cho_rasoat" | "da_rasoat" | "da_duyet" | "tu_choi" | "khong_huu_ich";
  /** Đánh giá của sinh viên — để cán bộ quyết định có trình admin */
  so_sao?: number | null;
  vote?: "up" | "down" | null;
  nhan_xet?: string | null;
  feedback_display?: string | null;
  staff_verdict?: "huu_ich" | "khong_huu_ich" | null;
  note: string | null;
  reviewer: string | null;
  approved_by: string | null;
  created_at: string;
  reviewed_at: string | null;
  decided_at: string | null;
}

export interface ReviewResult {
  ok: boolean;
  error?: string;
  item?: ReviewItem;
  reload?: { loaded: boolean; error: string | null };
}

export async function listReviews(status?: string): Promise<{
  items: ReviewItem[];
  counts: Record<string, number>;
}> {
  try {
    const qs = status ? `?status=${status}` : "";
    const r = await authedFetch<{ items: ReviewItem[]; counts: Record<string, number> }>(
      `/api/reviews${qs}`,
    );
    return { items: r.items ?? [], counts: r.counts ?? {} };
  } catch {
    return { items: [], counts: {} };
  }
}

export async function reviewAnswer(
  id: string,
  note: string,
  editedAnswer?: string,
  huu_ich = true,
): Promise<ReviewResult> {
  try {
    return await authedFetch(`/api/reviews/${id}/review`, {
      method: "POST",
      body: JSON.stringify({
        note: note || null,
        edited_answer: editedAnswer || null,
        huu_ich,
      }),
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function decideAnswer(
  id: string,
  action: "duyet" | "tu_choi",
  note?: string,
): Promise<ReviewResult> {
  try {
    return await authedFetch(`/api/reviews/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ action, note: note ?? null }),
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ===============================================================
// QUẢN TRỊ: người dùng / chủ đề / báo cáo
// ===============================================================
export interface AdminUser {
  username: string;
  display: string;
  role: "admin" | "can_bo" | "sinh_vien";
}

export interface RoleOption {
  id: AdminUser["role"];
  name: string;
}

export interface Topic {
  id: string;
  name: string;
  description: string;
  phong_ban: string;
  tag_id: string;
  custom: boolean;
}

export interface ReportData {
  generated_at: string;
  overview: {
    n_messages: number;
    n_sessions: number;
    n_users: number;
    n_roles: number;
    n_feedback: number;
    avg_stars: number;
    ratio_up: number;
    hang_cho_pending: number;
    hang_cho_done: number;
    docs_pending: number;
    docs_approved: number;
    review_pending: number;
    review_approved: number;
    n_notifications: number;
  };
  activity: { date: string; messages: number; feedback: number; hang_cho: number }[];
  decisions: { name: string; n: number }[];
  per_tag: { tag: string; n: number; avg_stars: number }[];
  recent_feedback: { question: string; so_sao: number; vote: string; nhan_xet: string | null }[];
  top_questions: { question: string; n: number }[];
  staff_replies: { name: string; n: number }[];
  pending_review: { id: string; question: string; status: string }[];
}

export async function adminListUsers(): Promise<{ users: AdminUser[]; roles: RoleOption[] }> {
  try {
    const r = await authedFetch<{ users: AdminUser[]; roles: RoleOption[] }>("/api/admin/users");
    return { users: r.users ?? [], roles: r.roles ?? [] };
  } catch {
    return { users: [], roles: [] };
  }
}

export async function adminAddUser(body: {
  username: string;
  password: string;
  role: AdminUser["role"];
  display?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    return await authedFetch("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function adminUpdateUser(
  username: string,
  patch: { display?: string; role?: AdminUser["role"]; password?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await authedFetch(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function adminDeleteUser(username: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await authedFetch(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function adminListTopics(): Promise<Topic[]> {
  try {
    const r = await authedFetch<{ topics: Topic[] }>("/api/admin/topics");
    return r.topics ?? [];
  } catch {
    return [];
  }
}

export async function adminSaveTopic(
  topic: Partial<Topic> & { id?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const isNew = !topic.id;
    const path = topic.id
      ? `/api/admin/topics/${encodeURIComponent(topic.id)}`
      : "/api/admin/topics";
    return await authedFetch(path, {
      method: isNew ? "POST" : "PUT",
      body: JSON.stringify({
        name: topic.name,
        description: topic.description,
        phong_ban: topic.phong_ban,
        tag_id: topic.tag_id,
      }),
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function adminDeleteTopic(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await authedFetch(`/api/admin/topics/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function adminReports(days = 7): Promise<ReportData | null> {
  try {
    const r = await authedFetch<{ report: ReportData }>(`/api/admin/reports?days=${days}`);
    return r.report ?? null;
  } catch {
    return null;
  }
}
