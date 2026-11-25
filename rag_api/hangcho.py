"""
hangcho.py — Chuyển câu hỏi cho cán bộ tư vấn (nghiệp vụ 3.0 / kho D3).

JSON-lines tại data/hang_cho.json.
Trạng thái: "cho_xu_ly" → "da_tra_loi".

Xảy ra khi: AI không đủ tin cậy (decision OUT_OF_SCOPE), hỏi lại quá lâu
(ASK_BACK), LLM lỗi/quá thời gian — hoặc sinh viên tự bấm chuyển.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
QUEUE_FILE = DATA_DIR / "hang_cho.json"

_lock = threading.Lock()

VALID_STATUS = {"cho_xu_ly", "da_tra_loi"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_all() -> list[dict]:
    if not QUEUE_FILE.exists():
        return []
    out: list[dict] = []
    for line in QUEUE_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _write_all(rows: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = QUEUE_FILE.with_suffix(".tmp")
    tmp.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    tmp.replace(QUEUE_FILE)


def add(
    *,
    question: str,
    user: Optional[str] = None,
    display: Optional[str] = None,
    answer_id: Optional[str] = None,
    tag: Optional[str] = None,
    reason: Optional[str] = None,
    ai_answer: Optional[str] = None,
) -> dict:
    """Đưa 1 câu hỏi vào hàng chờ chờ cán bộ."""
    q = (question or "").strip()
    if not q:
        raise ValueError("question là bắt buộc")

    rec = {
        "id": uuid4().hex[:12],
        "question": q[:2000],
        "user": user,
        "display": display,
        "answer_id": answer_id,
        "tag": tag,
        "reason": reason,
        "ai_answer": (ai_answer or "")[:1000] or None,
        "status": "cho_xu_ly",
        "reply": None,
        "replied_by": None,
        "replied_at": None,
        "created_at": _now(),
    }
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with QUEUE_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def items(status: Optional[str] = None, limit: int = 200) -> list[dict]:
    """Danh sách hàng chờ — mới nhất trước."""
    with _lock:
        rows = _read_all()
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows[:limit]


def reply(item_id: str, reply_text: str, replied_by: str) -> Optional[dict]:
    """Cán bộ trả lời → chuyển sang 'da_tra_loi'."""
    text = (reply_text or "").strip()
    if not text:
        raise ValueError("reply là bắt buộc")
    with _lock:
        rows = _read_all()
        hit = next((r for r in rows if r.get("id") == item_id), None)
        if hit is None:
            return None
        hit.update({
            "status": "da_tra_loi",
            "reply": text[:4000],
            "replied_by": replied_by,
            "replied_at": _now(),
        })
        _write_all(rows)
    return hit


def get(item_id: str) -> Optional[dict]:
    with _lock:
        rows = _read_all()
    return next((r for r in rows if r.get("id") == item_id), None)


def find_recent(question: str, user: Optional[str] = None,
                within_s: int = 600) -> Optional[dict]:
    """Chống tự động chuyển trùng lặp cho cùng 1 câu hỏi trong 1 phiên ngắn."""
    from datetime import timedelta

    with _lock:
        rows = _read_all()
    q = (question or "").strip()
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=within_s)
    for r in reversed(rows):
        if (r.get("question") or "").strip() != q:
            continue
        if user and r.get("user") != user:
            continue
        try:
            created = datetime.fromisoformat(r.get("created_at") or "")
        except ValueError:
            continue
        if created >= cutoff:
            return r
    return None


def counts() -> dict:
    with _lock:
        rows = _read_all()
    cho = sum(1 for r in rows if r.get("status") == "cho_xu_ly")
    return {
        "cho_xu_ly": cho,
        "da_tra_loi": len(rows) - cho,
        "tong": len(rows),
    }
