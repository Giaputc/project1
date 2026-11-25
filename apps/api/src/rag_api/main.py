"""
main.py — FastAPI cho RAG Sổ tay sinh viên UTC (Ollama).

Endpoints:
  GET  /health          — trạng thái Ollama + corpus (public)
  POST /api/auth/login  — đăng nhập admin → token
  POST /api/auth/guest  — vào bằng Khách → token guest riêng (guest_id)
  POST /api/ask         — JSON đầy đủ (không stream)
  POST /api/ask/stream  — SSE: event meta → token* → done (hoặc error)
  POST /api/preheat     — [ADMIN] nạp model vào RAM (~60s)
  POST /api/corpus/reload — [ADMIN] nạp lại corpus sau rebuild.py
  POST /api/feedback    — Đánh giá câu trả lời (↑↓ + sao + nhận xét) → D4
  GET  /api/feedback/items — [CÁN BỘ/ADMIN] xem sao + nhận xét sinh viên
  POST /api/feedback/{id}/to-review — [CÁN BỘ/ADMIN] tự đưa feedback vào rà soát
  GET  /api/feedback/stats — [ADMIN] tổng hợp đánh giá, trung bình theo tag
  POST /api/history     — [ĐĂNG NHẬP] lưu 1 tin nhắn vào lịch sử → D1
  GET  /api/history/sessions — danh sách phiên của chính mình
  GET  /api/history/{sid}     — tải lại 1 phiên
  DELETE /api/history/{sid}   — xoá 1 phiên
  POST /api/hangcho     — [ĐĂNG NHẬP] chuyển câu hỏi cho cán bộ → D3
  GET  /api/hangcho     — [CÁN BỘ/ADMIN] xem hàng chờ + số liệu
  POST /api/hangcho/{id}/reply — [CÁN BỘ/ADMIN] trả lời câu hỏi chờ
  GET  /api/notifications     — thông báo của chính mình (đọc/chưa đọc)
  POST /api/notifications/{id}/read — đánh dấu đã đọc
  POST /api/notifications/read-all — đánh dấu tất cả đã đọc
  POST /api/knowledge         — [CÁN BỘ/ADMIN] đề xuất tài liệu → D3
  GET  /api/knowledge         — [CÁN BỘ/ADMIN] danh sách tài liệu/đáp án
  POST /api/knowledge/{id}/review — [ADMIN] duyệt/từ chối → D2 sau reload
  GET  /api/reviews           — [CÁN BỘ/ADMIN] hàng rà soát đáp án (D4)
  POST /api/reviews/{id}/review  — [CÁN BỘ/ADMIN] rà soát chuyên môn
  POST /api/reviews/{id}/decide  — [ADMIN] phê duyệt → đưa ngược vào tri thức
  GET  /api/admin/topics      — [ADMIN] chủ đề / phòng ban (D6)
  POST /api/admin/topics      — [ADMIN] thêm chủ đề
  PUT/DELETE /api/admin/topics/{id} — [ADMIN] sửa / xoá chủ đề
  GET/POST /api/admin/users   — [ADMIN] quản lý người dùng & phân quyền (D5)
  PUT/DELETE /api/admin/users/{username} — [ADMIN] sửa / xoá người dùng
  GET  /api/admin/reports    — [ADMIN/CÁN BỘ] báo cáo tổng hợp (6.0)

  [ADMIN] GET  /api/admin/tags              — danh sách tag (định nghĩa + số chunk)
  [ADMIN] POST /api/admin/tags              — thêm tag mới
  [ADMIN] PUT  /api/admin/tags/{id}         — sửa description / synonyms / examples
  [ADMIN] DELETE /api/admin/tags/{id}       — xoá tag
  [ADMIN] GET  /api/admin/chunks?q=         — danh sách chunk + tag hiện tại
  [ADMIN] PUT  /api/admin/chunks/{id}/tags  — gán tag thủ công (ghi đè rule)
  [ADMIN] DELETE /api/admin/chunks/{id}/tags — khôi phục tag rule

Phân quyền:
  - Khách (và request không token): chat bình thường NHƯNG `params` bị bỏ qua
    (server dùng default). `force_tag` (chọn hashtag khi mơ hồ) vẫn cho khách.
  - Cán bộ (canbo/canbo123): toàn quyền chat như admin về params KHÔNG —
    chỉ xem/trả lời hàng chờ; không chỉnh tham số/tag.
  - Admin: gửi params bình thường + toàn quyền admin.

Chạy:  make dev-api      (hoặc PYTHONPATH=apps/api/src .venv/bin/uvicorn rag_api.main:app --port 8000)
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from rag_api import auth
from rag_api import catalog as ct
from rag_api import feedback as fb
from rag_api import hangcho as hq
from rag_api import history as hs
from rag_api import knowledge as kn
from rag_api import notifications as nt
from rag_api import rag_engine as eng
from rag_api import reports as rp
from rag_api import reviews as rv

OLLAMA = "http://localhost:11434"

app = FastAPI(title="RAG API — Sổ tay sinh viên UTC (Ollama)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _warm_corpus():
    """Nạp corpus + embed cache ở thread nền ngay khi khởi động."""
    threading.Thread(target=eng.ensure_loaded, daemon=True).start()


# ---------------------------------------------------------------
# Schema
# ---------------------------------------------------------------
class Params(BaseModel):
    model: Optional[str] = None
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(None, ge=10, le=4096)
    topk: Optional[int] = Field(None, ge=1, le=10)
    rrf_k: Optional[int] = Field(None, ge=1, le=200)
    tag_boost: Optional[float] = Field(None, ge=0.0, le=5.0)
    margin_ask: Optional[float] = Field(None, ge=0.0, le=1.0)
    score_low: Optional[float] = Field(None, ge=0.0, le=1.0)
    keep_alive: Optional[str] = None
    use_llm: Optional[bool] = True


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    params: Params = Params()
    force_tag: Optional[str] = Field(
        None,
        description="Tag người dùng chọn thủ công khi câu hỏi mơ hồ "
                    "(bypass quyết định theo ngưỡng, retrieve scoped theo tag này)",
    )


class PreheatRequest(BaseModel):
    model: Optional[str] = None


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1, max_length=200)


class GuestRequest(BaseModel):
    """id riêng của client khách — tách lịch sử/thông báo giữa các client."""
    guest_id: Optional[str] = Field(None, max_length=64)


class ChunkTagsRequest(BaseModel):
    tags: list[str] = Field(..., max_length=10)


class TagDefRequest(BaseModel):
    id: Optional[str] = Field(None, pattern=r"^[a-z0-9-]+$")
    description: Optional[str] = None
    synonyms: Optional[list[str]] = None
    examples: Optional[list[str]] = None


class FeedbackRequest(BaseModel):
    """Đánh giá câu trả lời — nghiệp vụ 4.0 (kho D4)."""

    answer_id: str = Field(..., min_length=1, max_length=64)
    question: str = Field("", max_length=2000)
    vote: str = Field(..., pattern=r"^(up|down)$")
    so_sao: int = Field(..., ge=1, le=5)
    nhan_xet: Optional[str] = Field(None, max_length=2000)
    answer_preview: Optional[str] = Field(None, max_length=500)
    answer: Optional[str] = Field(None, max_length=8000)
    tag: Optional[str] = Field(None, max_length=64)
    sources: Optional[list[str]] = None


class HistoryItemRequest(BaseModel):
    """1 tin nhắn trong lịch sử — nghiệp vụ 1.0 (kho D1)."""

    session_id: str = Field(..., min_length=1, max_length=64)
    item: dict = Field(..., description="{id, role, content, meta?, done?, error?}")


class HangChoRequest(BaseModel):
    """Chuyển câu hỏi cho cán bộ — nghiệp vụ 3.0 (kho D3)."""

    question: str = Field(..., min_length=1, max_length=2000)
    answer_id: Optional[str] = Field(None, max_length=64)
    tag: Optional[str] = Field(None, max_length=64)
    reason: Optional[str] = Field(None, max_length=300)
    ai_answer: Optional[str] = Field(None, max_length=4000)


class HangChoReplyRequest(BaseModel):
    reply: str = Field(..., min_length=1, max_length=4000)


class DocProposeRequest(BaseModel):
    """Cán bộ đề xuất tài liệu (nghiệp vụ 5.0 / D3)."""

    title: str = Field(..., min_length=1, max_length=200)
    text: str = Field(..., min_length=1, max_length=8000)
    tag: Optional[str] = Field(None, max_length=64)
    source: Optional[str] = Field(None, max_length=300)


class DocReviewRequest(BaseModel):
    action: str = Field(..., pattern=r"^(duyet|tu_choi)$")
    note: Optional[str] = Field(None, max_length=1000)


class ReviewActionRequest(BaseModel):
    note: Optional[str] = Field(None, max_length=1000)
    edited_answer: Optional[str] = Field(None, max_length=8000)
    huu_ich: bool = True   # cán bộ đánh giá: có đưa lên admin hay không


class ReviewDecideRequest(BaseModel):
    action: str = Field(..., pattern=r"^(duyet|tu_choi)$")
    note: Optional[str] = Field(None, max_length=1000)


class ReviewManualRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    answer: str = Field(..., min_length=1, max_length=8000)
    tag: Optional[str] = Field(None, max_length=64)


class UserRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=6, max_length=200)
    role: str = Field(..., pattern=r"^(admin|can_bo|sinh_vien)$")
    display: Optional[str] = Field(None, max_length=80)


class UserPatchRequest(BaseModel):
    display: Optional[str] = Field(None, max_length=80)
    role: Optional[str] = Field(None, pattern=r"^(admin|can_bo|sinh_vien)$")
    password: Optional[str] = Field(None, min_length=6, max_length=200)


class TopicRequest(BaseModel):
    name: Optional[str] = Field(None, max_length=120)
    description: Optional[str] = Field(None, max_length=1000)
    phong_ban: Optional[str] = Field(None, max_length=120)
    tag_id: Optional[str] = Field(None, max_length=64)


def _effective_params(req: AskRequest, session: Optional[dict]) -> dict[str, Any]:
    """Chỉ admin được gửi params — guest/request thường bị bỏ qua (dùng default)."""
    if session and session.get("role") == "admin":
        return req.params.model_dump(exclude_none=True)
    return {}


# ---------------------------------------------------------------
# Tự động chuyển câu hỏi cho cán bộ (sơ đồ Use case: độ tin cậy < ngưỡng,
# không truy xuất được ngữ cảnh hoặc LLM lỗi/quá thời gian)
# ---------------------------------------------------------------
def _auto_handoff(question: str, session: Optional[dict], reason: str, *,
                  answer_id: Optional[str] = None, tag: Optional[str] = None,
                  ai_answer: Optional[str] = None) -> Optional[dict]:
    user = (session or {}).get("username") or "khach"
    display = (session or {}).get("display") or "Khách"
    if hq.find_recent(question, user):
        return None                      # cùng 1 câu hỏi đã chuyển trong 10 phút
    rec = hq.add(question=question, user=user, display=display,
                 answer_id=answer_id, tag=tag, reason=reason[:300],
                 ai_answer=ai_answer)
    nt.broadcast_staff(
        type="hang_cho_moi",
        title="Câu hỏi mới cần cán bộ xử lý",
        body=(question or "")[:180],
        ref_id=rec["id"], exclude=user,
    )
    return rec


def _handoff_from_meta(meta: dict, question: str, session: Optional[dict],
                       answer_id: Optional[str] = None) -> Optional[dict]:
    """OUT_OF_SCOPE hoặc không có nguồn → tự động đưa vào hàng chờ."""
    out = meta.get("decision") == "OUT_OF_SCOPE"
    no_context = not meta.get("sources")
    if not (out or no_context):
        return None
    reason = meta.get("why") or ("AI không truy xuất được ngữ cảnh"
                                 if no_context else "Độ tin cậy thấp")
    return _auto_handoff(question, session, reason, answer_id=answer_id,
                         tag=meta.get("top_tag"))


# ---------------------------------------------------------------
# Auth
# ---------------------------------------------------------------
@app.post("/api/auth/login")
def api_login(req: LoginRequest):
    r = auth.login(req.username, req.password)
    if r is None:
        return {"ok": False, "error": "Sai tài khoản hoặc mật khẩu"}
    return {"ok": True, **r}


@app.post("/api/auth/guest")
def api_guest(req: Optional[GuestRequest] = None):
    return {"ok": True, **auth.issue_guest(req.guest_id if req else None)}


# ---------------------------------------------------------------
# Health
# ---------------------------------------------------------------
@app.get("/health")
async def health():
    ollama_ok, models, ollama_err = False, [], None
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{OLLAMA}/api/tags")
            r.raise_for_status()
            models = [m["name"] for m in r.json().get("models", [])]
            ollama_ok = True
    except Exception as e:
        ollama_err = f"{type(e).__name__}: {e}"

    # nạp corpus ở chế độ không chặn (để /health trả lời ngay)
    eng.ensure_loaded(blocking=False)

    return {
        "ollama": {"ok": ollama_ok, "url": OLLAMA, "models": models, "error": ollama_err},
        "corpus": {
            "loaded": eng.is_loaded(),
            "error": eng.load_error(),
            "loading": (not eng.is_loaded() and eng.load_error() is None),
        },
        "defaults": eng.DEFAULT_PARAMS,
        "time": round(time.time(), 1),
    }


@app.post("/api/corpus/load")
def corpus_load():
    """Ép nạp corpus (block tới khi xong / lỗi) — FE gọi sau khi health báo loading."""
    ok = eng.ensure_loaded(blocking=True)
    return {"loaded": ok, "error": eng.load_error()}


@app.post("/api/corpus/reload")
def corpus_reload(
    x_build_secret: Optional[str] = Header(default=None, alias="X-Build-Secret"),
    admin: Optional[dict] = Depends(auth.optional_admin),
):
    """Nạp lại corpus + embed cache từ disk.
    Cho phép: admin (token) hoặc secret nội bộ (rebuild.py chạy local)."""
    if admin is None and x_build_secret != BUILD_SECRET:
        raise HTTPException(403, "Cần token admin hoặc X-Build-Secret hợp lệ")
    return eng.reload_corpus()


# ---------------------------------------------------------------
# Rebuild từ .md — admin (chạy rebuild.py: chunk → tag → embed → reload)
# ---------------------------------------------------------------
_rebuild_lock = threading.Lock()
_rebuild_state: dict[str, Any] = {"running": False}

# Secret nội bộ: rebuild.py (script local) dùng để gọi /api/corpus/reload
# mà không cần token admin. Lưu trong rag_api/.rebuild_secret.
_BUILD_SECRET_FILE = Path(__file__).resolve().parent / ".rebuild_secret"


def _build_secret() -> str:
    if _BUILD_SECRET_FILE.exists():
        s = _BUILD_SECRET_FILE.read_text(encoding="utf-8").strip()
        if s:
            return s
    import secrets as _secrets
    s = _secrets.token_hex(16)
    _BUILD_SECRET_FILE.write_text(s, encoding="utf-8")
    return s


BUILD_SECRET = _build_secret()


@app.post("/api/admin/rebuild")
def admin_rebuild(_: dict = Depends(auth.require_admin)):
    """Chạy rebuild.py (md → chunks → tag → embed chunk đổi → reload).
    Mất vài giây tới ~1 phút tuỳ số chunk đổi."""
    import subprocess
    import sys as _sys

    if not _rebuild_lock.acquire(blocking=False):
        return {"ok": False, "error": "Rebuild đang chạy — chờ chút"}
    try:
        _rebuild_state["running"] = True
        t0 = time.time()
        try:
            p = subprocess.run(
                [_sys.executable, "rebuild.py"],
                cwd=str(eng.ROOT / "scripts"), capture_output=True, text=True,
                timeout=600,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Rebuild quá 600s — dừng"}
        out = (p.stdout or "") + (("\n" + p.stderr) if p.stderr else "")
        return {
            "ok": p.returncode == 0,
            "seconds": round(time.time() - t0, 1),
            "returncode": p.returncode,
            "output": out[-4000:],       # tail log cho FE hiển thị
        }
    finally:
        _rebuild_state["running"] = False
        _rebuild_lock.release()


# ---------------------------------------------------------------
# Ask — JSON (không stream)
# ---------------------------------------------------------------
@app.post("/api/ask")
def ask(req: AskRequest, session: Optional[dict] = Depends(auth.current_role)):
    try:
        out = eng.ask(req.question, _effective_params(req, session),
                      force_tag=req.force_tag)
        if out.get("ok") is not False and not out.get("error"):
            rec = _handoff_from_meta(out, req.question, session,
                                     answer_id=out.get("answer_id"))
            if rec:
                out["handoff"] = {"id": rec["id"], "status": rec["status"]}
        return out
    except RuntimeError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---------------------------------------------------------------
# Ask — SSE stream
# ---------------------------------------------------------------
def _sse(payload: dict) -> str:
    return f"event: {payload.get('type', 'message')}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.post("/api/ask/stream")
async def ask_stream(req: AskRequest, session: Optional[dict] = Depends(auth.current_role)):
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    params = _effective_params(req, session)

    def _producer():
        try:
            for ev in eng.ask_stream(req.question, params,
                                     force_tag=req.force_tag):
                # await từ thread → dùng run_coroutine_threadsafe
                fut = asyncio.run_coroutine_threadsafe(queue.put(ev), loop)
                fut.result(timeout=30)
        except Exception as e:
            asyncio.run_coroutine_threadsafe(
                queue.put({"type": "error", "message": f"{type(e).__name__}: {e}"}), loop)
        finally:
            asyncio.run_coroutine_threadsafe(queue.put(None), loop)

    # chạy pipeline trong thread phụ → request handler vẫn stream được
    loop.run_in_executor(None, _producer)

    async def gen():
        # ID ổn định cho 1 câu trả lời — client gắn đánh giá vào đây
        answer_id = uuid4().hex[:12]
        while True:
            ev = await queue.get()
            if ev is None:
                break
            if isinstance(ev, dict) and ev.get("type") in ("meta", "done"):
                ev = {**ev, "answer_id": answer_id}
            if isinstance(ev, dict) and ev.get("type") == "meta":
                rec = _handoff_from_meta(ev, req.question, session, answer_id)
                if rec:
                    ev = {**ev, "handoff": {"id": rec["id"],
                                            "status": rec["status"]}}
            elif isinstance(ev, dict) and ev.get("type") == "error":
                # LLM lỗi / quá thời gian → chuyển cho cán bộ
                rec = _auto_handoff(
                    req.question, session,
                    f"LLM lỗi/quá thời gian: {ev.get('message', '')}"[:300],
                    answer_id=answer_id)
                if rec:
                    ev = {**ev, "handoff": {"id": rec["id"],
                                            "status": rec["status"]}}
            yield _sse(ev)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache",
                 "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------
# Feedback — Đánh giá câu trả lời (nghiệp vụ 4.0 / D4)
# ---------------------------------------------------------------
@app.post("/api/feedback")
def api_feedback(req: FeedbackRequest,
                 session: Optional[dict] = Depends(auth.current_role)):
    """Khách và admin đều đánh giá được (mọi use case include Đăng nhập)."""
    try:
        rec = fb.add_feedback(
            answer_id=req.answer_id,
            question=req.question,
            vote=req.vote,
            so_sao=req.so_sao,
            nhan_xet=req.nhan_xet,
            answer_preview=req.answer_preview,
            answer=req.answer,
            tag=req.tag,
            sources=req.sources,
            role=(session or {}).get("role"),
            user=(session or {}).get("username") or "khach",
            display=(session or {}).get("display"),
        )
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    # đánh giá cao → tự động đưa vào hàng rà soát chuyên môn (cán bộ → admin)
    review = rv.enqueue_from_feedback(rec)
    if review:
        nt.broadcast_staff(
            type="danh_gia_moi",
            title="Sinh viên đánh giá cao một câu trả lời",
            body=(f"{rec.get('so_sao')} sao · {rec.get('question', '')[:120]}\n"
                  f"Nhận xét: {(rec.get('nhan_xet') or '—')[:160]}"),
            ref_id=review["id"],
            exclude=(session or {}).get("username"),
        )
    return {"ok": True, "feedback": rec,
            "review_id": review["id"] if review else None}


@app.get("/api/feedback/items")
def api_feedback_items(limit: int = 200,
                       _: dict = Depends(auth.require_permission("review_answer"))):
    """Cán bộ/admin xem đầy đủ sao + nhận xét của sinh viên (D4)."""
    return {"ok": True, "items": fb.list_feedback(limit)}


@app.post("/api/feedback/{feedback_id}/to-review")
def api_feedback_to_review(
    feedback_id: str,
    _: dict = Depends(auth.require_permission("review_answer")),
):
    """Cán bộ tự đưa 1 feedback vào hàng rà soát (kể cả <4 sao)."""
    rec = next((r for r in fb.list_feedback(1000)
                if r.get("id") == feedback_id), None)
    if rec is None:
        raise HTTPException(404, "Không tìm thấy đánh giá")
    item = rv.enqueue_from_feedback(rec, force=True)
    if item is None:
        return {"ok": False, "error": "Feedback này đã có trong hàng rà soát hoặc thiếu nội dung"}
    return {"ok": True, "item": item}


@app.get("/api/feedback/stats")
def api_feedback_stats(limit: int = 200,
                       _: dict = Depends(auth.require_admin)):
    """Tổng hợp đánh giá cho admin (báo cáo 6.0)."""
    return {"ok": True, "stats": fb.stats(), "items": fb.list_feedback(limit)}


# ---------------------------------------------------------------
# History — Lịch sử câu hỏi (nghiệp vụ 1.0 / D1)
# ---------------------------------------------------------------
@app.post("/api/history")
def api_history_save(req: HistoryItemRequest,
                     s: dict = Depends(auth.require_login)):
    try:
        rec = hs.save_item(s["username"], req.session_id, req.item)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "saved": {"id": rec["id"]}}


@app.get("/api/history/sessions")
def api_history_sessions(limit: int = 50,
                         s: dict = Depends(auth.require_login)):
    """PHẢI đặt trước /api/history/{session_id} — nếu không 'sessions'
    sẽ bị bắt làm path param."""
    return {"ok": True, "sessions": hs.sessions(s["username"], limit)}


@app.get("/api/history/{session_id}")
def api_history_load(session_id: str,
                     s: dict = Depends(auth.require_login)):
    return {"ok": True, "session_id": session_id,
            "items": hs.load(s["username"], session_id)}


@app.delete("/api/history/{session_id}")
def api_history_delete(session_id: str,
                       s: dict = Depends(auth.require_login)):
    n = hs.delete(s["username"], session_id)
    return {"ok": True, "removed": n}


# ---------------------------------------------------------------
# Hang chờ — Chuyển câu hỏi cho cán bộ (nghiệp vụ 3.0 / D3)
# ---------------------------------------------------------------
@app.post("/api/hangcho")
def api_hangcho_add(req: HangChoRequest,
                    s: dict = Depends(auth.require_login)):
    """Sinh viên (hoặc hệ thống khi AI thiếu tự tin) đưa vào hàng chờ."""
    try:
        rec = hq.add(
            question=req.question,
            user=s.get("username"),
            display=s.get("display"),
            answer_id=req.answer_id,
            tag=req.tag,
            reason=req.reason,
            ai_answer=req.ai_answer,
        )
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "item": rec, "counts": hq.counts()}


@app.get("/api/hangcho")
def api_hangcho_list(status: Optional[str] = None, limit: int = 200,
                     _: dict = Depends(auth.require_staff)):
    if status and status not in hq.VALID_STATUS:
        raise HTTPException(422, "status phải là cho_xu_ly hoặc da_tra_loi")
    return {"ok": True,
            "items": hq.items(status, limit),
            "counts": hq.counts()}


@app.post("/api/hangcho/{item_id}/reply")
def api_hangcho_reply(item_id: str, req: HangChoReplyRequest,
                      s: dict = Depends(auth.require_staff)):
    """Cán bộ trả lời → sinh viên thấy đáp án (D3)."""
    try:
        rec = hq.reply(item_id, req.reply, s.get("display") or s.get("username"))
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if rec is None:
        raise HTTPException(404, "Không tìm thấy câu hỏi trong hàng chờ")
    # thông báo cho đúng user đã gửi câu hỏi (guest có username riêng khach_<id>)
    owner = rec.get("user") or "khach"
    nt.add(user=owner, type="hang_cho_tra_loi",
           title="Cán bộ tư vấn đã trả lời câu hỏi của bạn",
           body=f"Câu hỏi: {rec.get('question', '')[:120]}\n\n"
                f"Trả lời: {(rec.get('reply') or '')[:800]}",
           ref_id=rec.get("id"))
    return {"ok": True, "item": rec}


# ---------------------------------------------------------------
# Preheat — admin
# ---------------------------------------------------------------
@app.post("/api/preheat")
async def preheat(req: PreheatRequest, _: dict = Depends(auth.require_admin)):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: eng.preheat(req.model))


# ===============================================================
# ADMIN — tag (routing) + tag thủ công theo chunk
# ===============================================================
@app.get("/api/admin/tags")
def admin_tags(_: dict = Depends(auth.require_admin)):
    return {"ok": True, "tags": eng.admin_list_tags()}


@app.post("/api/admin/tags")
def admin_add_tag(req: TagDefRequest, _: dict = Depends(auth.require_admin)):
    try:
        if not req.id or not req.description:
            return {"ok": False, "error": "Cần id + description"}
        return {"ok": True, **eng.admin_add_tag(
            req.id, req.description, req.synonyms, req.examples)}
    except (ValueError, RuntimeError) as e:
        return {"ok": False, "error": str(e)}


@app.put("/api/admin/tags/{tag_id}")
def admin_update_tag(tag_id: str, req: TagDefRequest,
                     _: dict = Depends(auth.require_admin)):
    try:
        return {"ok": True, **eng.admin_update_tag(
            tag_id, req.description, req.synonyms, req.examples)}
    except (ValueError, RuntimeError) as e:
        return {"ok": False, "error": str(e)}


@app.delete("/api/admin/tags/{tag_id}")
def admin_delete_tag(tag_id: str, _: dict = Depends(auth.require_admin)):
    try:
        return {"ok": True, **eng.admin_delete_tag(tag_id)}
    except (ValueError, RuntimeError) as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/admin/chunks")
def admin_chunks(q: Optional[str] = None, limit: int = 300,
                 _: dict = Depends(auth.require_admin)):
    try:
        return {"ok": True, "chunks": eng.admin_list_chunks(q, limit)}
    except RuntimeError as e:
        return {"ok": False, "error": str(e)}


@app.put("/api/admin/chunks/{chunk_id}/tags")
def admin_set_chunk_tags(chunk_id: str, req: ChunkTagsRequest,
                         _: dict = Depends(auth.require_admin)):
    try:
        return {"ok": True, **eng.admin_set_chunk_tags(chunk_id, req.tags)}
    except (ValueError, RuntimeError) as e:
        return {"ok": False, "error": str(e)}


@app.delete("/api/admin/chunks/{chunk_id}/tags")
def admin_reset_chunk_tags(chunk_id: str,
                           _: dict = Depends(auth.require_admin)):
    try:
        return {"ok": True, **eng.admin_reset_chunk_tags(chunk_id)}
    except (ValueError, RuntimeError) as e:
        return {"ok": False, "error": str(e)}


# ===============================================================
# THÔNG BÁO (kho THONG_BAO / D5)
# ===============================================================
@app.get("/api/notifications")
def api_notifications(unread_only: bool = False, limit: int = 50,
                      s: dict = Depends(auth.require_login)):
    user = s.get("username") or "khach"
    return {"ok": True, "items": nt.for_user(user, unread_only, limit),
            "counts": nt.counts(user)}


@app.post("/api/notifications/read-all")
def api_notifications_read_all(s: dict = Depends(auth.require_login)):
    user = s.get("username") or "khach"
    return {"ok": True, "marked": nt.mark_all(user), "counts": nt.counts(user)}


@app.post("/api/notifications/{nid}/read")
def api_notification_read(nid: str, s: dict = Depends(auth.require_login)):
    user = s.get("username") or "khach"
    if not nt.mark_read(user, nid):
        raise HTTPException(404, "Không tìm thấy thông báo")
    return {"ok": True, "counts": nt.counts(user)}


# ===============================================================
# TRI THỨC — đề xuất / phê duyệt tài liệu (nghiệp vụ 5.0 / D3 → D2)
# ===============================================================
@app.post("/api/knowledge")
def api_knowledge_propose(req: DocProposeRequest,
                          s: dict = Depends(auth.require_permission("propose_doc"))):
    try:
        rec = kn.propose_doc(
            title=req.title, text=req.text, tag=req.tag, source=req.source,
            user=s.get("username"), display=s.get("display"))
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    nt.broadcast_staff(type="he_thong",
                       title="Có tài liệu mới đề xuất",
                       body=req.title[:180], ref_id=rec["id"],
                       exclude=s.get("username"))
    return {"ok": True, "item": rec}


@app.get("/api/knowledge")
def api_knowledge_list(status: Optional[str] = None,
                       kind: Optional[str] = None, limit: int = 200,
                       _: dict = Depends(auth.require_permission("propose_doc"))):
    if status and status not in kn.VALID_STATUS:
        raise HTTPException(422, "status không hợp lệ")
    return {"ok": True, "items": kn.items(status, kind, limit),
            "counts": kn.counts()}


@app.post("/api/knowledge/{entry_id}/review")
def api_knowledge_review(entry_id: str, req: DocReviewRequest,
                         s: dict = Depends(auth.require_permission("approve_doc"))):
    try:
        rec = kn.review(entry_id, req.action,
                        s.get("display") or s.get("username"), req.note)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if rec is None:
        raise HTTPException(404, "Không tìm thấy tài liệu chờ duyệt")
    reload_info = None
    if req.action == "duyet":
        try:
            reload_info = eng.reload_corpus()   # embed + index vào D2 ngay
        except Exception as e:
            reload_info = {"loaded": False, "error": str(e)}
    return {"ok": True, "item": rec, "reload": reload_info}


# ===============================================================
# RÀ SOÁT & PHÊ DUYỆT CÂU TRẢ LỜI (nghiệp vụ 4.0 / D4)
# ===============================================================
@app.get("/api/reviews")
def api_reviews_list(status: Optional[str] = None, limit: int = 200,
                     _: dict = Depends(auth.require_permission("review_answer"))):
    if status and status not in rv.VALID_STATUS:
        raise HTTPException(422, "status không hợp lệ")
    return {"ok": True, "items": rv.items(status, limit), "counts": rv.counts()}


@app.post("/api/reviews")
def api_reviews_manual(req: ReviewManualRequest,
                       s: dict = Depends(auth.require_permission("review_answer"))):
    try:
        rec = rv.add_manual(question=req.question, answer=req.answer,
                            tag=req.tag, user=s.get("username"))
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "item": rec}


@app.post("/api/reviews/{item_id}/review")
def api_reviews_review(item_id: str, req: ReviewActionRequest,
                       s: dict = Depends(auth.require_permission("review_answer"))):
    rec = rv.review(item_id, s.get("display") or s.get("username"),
                    req.note, req.edited_answer, huu_ich=req.huu_ich)
    if rec is None:
        raise HTTPException(404, "Không tìm thấy đáp án cần rà soát")
    return {"ok": True, "item": rec}


@app.post("/api/reviews/{item_id}/decide")
def api_reviews_decide(item_id: str, req: ReviewDecideRequest,
                       s: dict = Depends(auth.require_permission("approve_answer"))):
    try:
        rec = rv.decide(item_id, req.action,
                        s.get("display") or s.get("username"), req.note)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if rec is None:
        raise HTTPException(404, "Không tìm thấy đáp án đã rà soát")
    reload_info = None
    if req.action == "duyet":
        try:
            reload_info = eng.reload_corpus()
        except Exception as e:
            reload_info = {"loaded": False, "error": str(e)}
    return {"ok": True, "item": rec, "reload": reload_info}


# ===============================================================
# CHỦ ĐỀ / PHÒNG BAN (kho D6)
# ===============================================================
@app.get("/api/admin/topics")
def admin_topics(_: dict = Depends(auth.require_permission("manage_topics"))):
    return {"ok": True, "topics": ct.list_topics()}


@app.post("/api/admin/topics")
def admin_add_topic(req: TopicRequest,
                    _: dict = Depends(auth.require_permission("manage_topics"))):
    if not req.name:
        return {"ok": False, "error": "Cần tên chủ đề"}
    import re
    tid = req.tag_id or re.sub(r"[^a-z0-9]+", "-", req.name.lower()).strip("-")[:64]
    try:
        return {"ok": True, "topic": ct.upsert(tid, req.model_dump(), create=True)}
    except ValueError as e:
        return {"ok": False, "error": str(e)}


@app.put("/api/admin/topics/{topic_id}")
def admin_update_topic(topic_id: str, req: TopicRequest,
                       _: dict = Depends(auth.require_permission("manage_topics"))):
    try:
        return {"ok": True, "topic": ct.upsert(topic_id, req.model_dump(exclude_none=True))}
    except ValueError as e:
        return {"ok": False, "error": str(e)}


@app.delete("/api/admin/topics/{topic_id}")
def admin_delete_topic(topic_id: str,
                       _: dict = Depends(auth.require_permission("manage_topics"))):
    if not ct.delete(topic_id):
        return {"ok": False, "error": "Chỉ xoá được chủ đề tự thêm"}
    return {"ok": True}


# ===============================================================
# QUẢN LÝ NGƯỜI DÙNG & PHÂN QUYỀN (kho D5)
# ===============================================================
@app.get("/api/admin/users")
def admin_users(_: dict = Depends(auth.require_permission("manage_users"))):
    return {"ok": True, "users": auth.list_users(), "roles": auth.public_roles()}


@app.post("/api/admin/users")
def admin_add_user(req: UserRequest,
                   s: dict = Depends(auth.require_permission("manage_users"))):
    try:
        return {"ok": True, "user": auth.add_user(
            req.username, req.password, req.role, req.display)}
    except ValueError as e:
        return {"ok": False, "error": str(e)}


@app.put("/api/admin/users/{username}")
def admin_update_user(username: str, req: UserPatchRequest,
                      s: dict = Depends(auth.require_permission("manage_users"))):
    try:
        return {"ok": True, "user": auth.update_user(
            username, req.model_dump(exclude_none=True),
            current=s.get("username"))}
    except ValueError as e:
        return {"ok": False, "error": str(e)}


@app.delete("/api/admin/users/{username}")
def admin_delete_user(username: str,
                      s: dict = Depends(auth.require_permission("manage_users"))):
    try:
        removed = auth.delete_user(username, current=s.get("username"))
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if not removed:
        raise HTTPException(404, "Không tìm thấy người dùng")
    return {"ok": True}


# ===============================================================
# BÁO CÁO TỔNG HỢP (nghiệp vụ 6.0)
# ===============================================================
@app.get("/api/admin/reports")
def admin_reports(days: int = 7,
                  _: dict = Depends(auth.require_permission("view_reports"))):
    return {"ok": True, "report": rp.build(max(1, min(days, 30)))}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("rag_api.main:app", host="127.0.0.1", port=8000)

#uvicorn rag_api.main:app --host 0.0.0.0 --port 8000