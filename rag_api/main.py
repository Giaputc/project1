"""
main.py — FastAPI cho RAG Sổ tay sinh viên UTC (Ollama).

Endpoints:
  GET  /health          — trạng thái Ollama + corpus (public)
  POST /api/auth/login  — đăng nhập admin → token
  POST /api/auth/guest  — vào bằng Khách → token guest
  POST /api/ask         — JSON đầy đủ (không stream)
  POST /api/ask/stream  — SSE: event meta → token* → done (hoặc error)
  POST /api/preheat     — [ADMIN] nạp model vào RAM (~60s)
  POST /api/corpus/reload — [ADMIN] nạp lại corpus sau rebuild.py

  [ADMIN] GET  /api/admin/tags              — danh sách tag (định nghĩa + số chunk)
  [ADMIN] POST /api/admin/tags              — thêm tag mới
  [ADMIN] PUT  /api/admin/tags/{id}         — sửa description / synonyms / examples
  [ADMIN] DELETE /api/admin/tags/{id}       — xoá tag
  [ADMIN] GET  /api/admin/chunks?q=         — danh sách chunk + tag hiện tại
  [ADMIN] PUT  /api/admin/chunks/{id}/tags  — gán tag thủ công (ghi đè rule)
  [ADMIN] DELETE /api/admin/chunks/{id}/tags — khôi phục tag rule

Phân quyền:
  - Khách (và request không token): chat bình thường NHƯNG `params` bị bỏ qua
    (server dùng default). `force_tag` (chọn hashtag khi mơ hồ) vẫn cho客人.
  - Admin: gửi params bình thường + toàn quyền admin.

Chạy:  .venv/bin/uvicorn rag_api.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from rag_api import auth
from rag_api import rag_engine as eng

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


class ChunkTagsRequest(BaseModel):
    tags: list[str] = Field(..., max_length=10)


class TagDefRequest(BaseModel):
    id: Optional[str] = Field(None, pattern=r"^[a-z0-9-]+$")
    description: Optional[str] = None
    synonyms: Optional[list[str]] = None
    examples: Optional[list[str]] = None


def _effective_params(req: AskRequest, session: Optional[dict]) -> dict[str, Any]:
    """Chỉ admin được gửi params — guest/request thường bị bỏ qua (dùng default)."""
    if session and session.get("role") == "admin":
        return req.params.model_dump(exclude_none=True)
    return {}


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
def api_guest():
    return {"ok": True, **auth.issue_guest()}


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
                cwd=str(eng.ROOT), capture_output=True, text=True, timeout=600,
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
        return eng.ask(req.question, _effective_params(req, session),
                       force_tag=req.force_tag)
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
        while True:
            ev = await queue.get()
            if ev is None:
                break
            yield _sse(ev)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache",
                 "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )


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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("rag_api.main:app", host="127.0.0.1", port=8000)

#uvicorn rag_api.main:app --host 0.0.0.0 --port 8000