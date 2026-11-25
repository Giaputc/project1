"""
history.py — Lịch sử câu hỏi/đáp (nghiệp vụ 1.0 / kho D1).

JSON-lines tại data/lich_su.json — 1 dòng = 1 tin nhắn.
Lưu phía server, theo username trong token (guest = `khach_<guest_id>` riêng từng client).
Không cần DB 13 bảng; migrate sang CAU_HOI/CAU_TRA_LOI sau này chỉ cần
đổi lớp lưu này.
"""

from __future__ import annotations

import json
import threading
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
HISTORY_FILE = DATA_DIR / "lich_su.json"

_lock = threading.Lock()

# meta.prompt / system_prompt rất dài, không cần cho UI → đừng lưu
_DROP_META_KEYS = ("prompt", "system_prompt")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_all() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    out: list[dict] = []
    for line in HISTORY_FILE.read_text(encoding="utf-8").splitlines():
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
    tmp = HISTORY_FILE.with_suffix(".tmp")
    tmp.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    tmp.replace(HISTORY_FILE)


def _trim(obj: Any) -> Any:
    """Bỏ meta prompt/system_prompt để file không phình."""
    if isinstance(obj, dict):
        return {
            k: _trim(v)
            for k, v in obj.items()
            if k not in _DROP_META_KEYS
        }
    if isinstance(obj, list):
        return [_trim(v) for v in obj]
    return obj


def save_item(user: str, session_id: str, item: dict) -> dict:
    """Lưu 1 tin nhắn. Ghi đè message_id trùng (upsert)."""
    mid = str(item.get("id") or "")[:64]
    if not mid:
        raise ValueError("item.id là bắt buộc")
    sid = str(session_id)[:64]
    if not sid:
        raise ValueError("session_id là bắt buộc")

    rec = {
        "user": user,
        "session_id": sid,
        "id": mid,
        "role": item.get("role"),
        "content": item.get("content") or "",
        "question": item.get("question"),
        "meta": _trim(item.get("meta")),
        "done": _trim(item.get("done")),
        "error": item.get("error"),
        "created_at": _now(),
    }

    with _lock:
        rows = _read_all()
        rows = [r for r in rows
                if not (r.get("user") == user
                        and r.get("session_id") == sid
                        and r.get("id") == mid)]
        rows.append(rec)
        _write_all(rows)
    return rec


def sessions(user: str, limit: int = 50) -> list[dict]:
    """Danh sách phiên của user — mới nhất trước."""
    with _lock:
        rows = [r for r in _read_all() if r.get("user") == user]

    grouped: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        grouped[r.get("session_id", "")].append(r)

    out: list[dict] = []
    for sid, msgs in grouped.items():
        if not sid:
            continue
        first_q = next(
            (m for m in msgs if m.get("role") == "user"), None
        )
        out.append({
            "session_id": sid,
            "preview": (first_q or {}).get("content", "")[:160],
            "n_messages": len(msgs),
            "updated_at": max((m.get("created_at") or "" for m in msgs),
                              default=""),
        })
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return out[:limit]


def load(user: str, session_id: str) -> list[dict]:
    """Tin nhắn của 1 phiên, theo thứ tự lưu."""
    with _lock:
        rows = _read_all()
    return [
        {"id": r.get("id"), "role": r.get("role"),
         "content": r.get("content") or "", "question": r.get("question"),
         "meta": r.get("meta"), "done": r.get("done"),
         "error": r.get("error")}
        for r in rows
        if r.get("user") == user and r.get("session_id") == session_id
    ]


def delete(user: str, session_id: str) -> int:
    with _lock:
        rows = _read_all()
        keep = [r for r in rows
                if not (r.get("user") == user
                        and r.get("session_id") == session_id)]
        removed = len(rows) - len(keep)
        if removed:
            _write_all(keep)
    return removed


def stats() -> dict:
    """Tổng quan cho admin (báo cáo 6.0)."""
    with _lock:
        rows = _read_all()
    users = {r.get("user") for r in rows}
    return {"n_messages": len(rows),
            "n_sessions": len({r.get("session_id") for r in rows}),
            "n_users": len(users)}


def has(user: Optional[str], session_id: str) -> bool:
    if not user:
        return False
    with _lock:
        return any(
            r.get("user") == user and r.get("session_id") == session_id
            for r in _read_all()
        )
