"""
feedback.py — Đánh giá câu trả lời (nghiệp vụ 4.0 / kho D4).

Lưu JSON-lines vào data/danh_gia.json — không cần DB 13 bảng.
Mỗi bản ghi:
  answer_id, question, answer_preview, vote ("up"|"down"),
  so_sao (1-5), nhan_xet, role, user, tag, sources, created_at
"""

from __future__ import annotations

import json
import threading
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from rag_api.store import DATA_DIR  # packages/backend/core — dùng chung

FEEDBACK_FILE = DATA_DIR / "danh_gia.json"

_lock = threading.Lock()

VALID_VOTES = {"up", "down"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_all() -> list[dict]:
    if not FEEDBACK_FILE.exists():
        return []
    out: list[dict] = []
    for line in FEEDBACK_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # bỏ dòng hỏng
    return out


def add_feedback(
    *,
    answer_id: str,
    question: str,
    vote: str,
    so_sao: int,
    nhan_xet: Optional[str] = None,
    answer_preview: Optional[str] = None,
    answer: Optional[str] = None,
    feedback_id: Optional[str] = None,
    tag: Optional[str] = None,
    sources: Optional[list] = None,
    role: Optional[str] = None,
    user: Optional[str] = None,
    display: Optional[str] = None,
) -> dict:
    if vote not in VALID_VOTES:
        raise ValueError("vote phải là 'up' hoặc 'down'")
    if not (1 <= so_sao <= 5):
        raise ValueError("so_sao phải trong khoảng 1-5")

    rec = {
        "id": feedback_id or uuid4().hex[:12],
        "answer_id": str(answer_id)[:64],
        "question": (question or "")[:2000],
        "answer_preview": (answer_preview or "")[:500],
        "answer": (answer or answer_preview or "")[:8000],
        "vote": vote,
        "so_sao": int(so_sao),
        "nhan_xet": (nhan_xet or "").strip()[:2000] or None,
        "tag": tag,
        "sources": sources or [],
        "role": role,
        "user": user,
        "display": display or user,
        "created_at": _now(),
    }

    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with FEEDBACK_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    return rec


def list_feedback(limit: int = 200) -> list[dict]:
    with _lock:
        rows = _read_all()
    return rows[-limit:][::-1]  # mới nhất trước


def stats() -> dict[str, Any]:
    with _lock:
        rows = _read_all()

    n = len(rows)
    if n == 0:
        return {
            "n": 0,
            "avg_stars": 0.0,
            "up": 0,
            "down": 0,
            "ratio_up": 0.0,
            "with_comment": 0,
            "per_tag": [],
            "recent": [],
        }

    stars = [r.get("so_sao") or 0 for r in rows]
    votes = Counter(r.get("vote") for r in rows)
    up, down = votes.get("up", 0), votes.get("down", 0)
    with_comment = sum(1 for r in rows if r.get("nhan_xet"))

    # trung bình theo tag
    by_tag: dict[str, list[int]] = defaultdict(list)
    for r in rows:
        by_tag[r.get("tag") or "khong-ro"].append(r.get("so_sao") or 0)

    per_tag = sorted(
        (
            {"tag": t, "n": len(v), "avg_stars": round(sum(v) / len(v), 2)}
            for t, v in by_tag.items()
        ),
        key=lambda x: x["n"],
        reverse=True,
    )

    # 5 đánh giá mới nhất có nhận xét
    recent = [
        {
            "question": r.get("question", ""),
            "so_sao": r.get("so_sao"),
            "vote": r.get("vote"),
            "nhan_xet": r.get("nhan_xet"),
            "tag": r.get("tag"),
            "created_at": r.get("created_at"),
        }
        for r in rows[::-1]
        if r.get("nhan_xet")
    ][:5]

    return {
        "n": n,
        "avg_stars": round(sum(stars) / n, 2),
        "up": up,
        "down": down,
        "ratio_up": round(up / n, 3),
        "with_comment": with_comment,
        "per_tag": per_tag,
        "recent": recent,
    }
