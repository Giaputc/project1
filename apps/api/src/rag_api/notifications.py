"""
notifications.py — Thông báo cho người dùng (kho THONG_BAO / D5).

JSON-lines tại data/thong_bao.jsonl. Dùng cho:
  - cán bộ trả lời xong → sinh viên nhận thông báo (có nội dung trả lời)
  - câu hỏi mới vào hàng chờ → cán bộ/admin nhận thông báo
  - sinh viên đánh giá cao → cán bộ/admin nhận thông báo `danh_gia_moi`
  - tài liệu / câu trả lời được phê duyệt → người đề xuất nhận thông báo
"""

from __future__ import annotations

from typing import Optional

from rag_api.store import JsonlStore, DATA_DIR, now

STORE = JsonlStore(DATA_DIR / "thong_bao.jsonl")

VALID_TYPES = {
    "hang_cho_tra_loi", "hang_cho_moi", "tai_lieu_duyet",
    "tra_loi_duyet", "danh_gia_moi", "he_thong",
}


def add(
    *,
    user: str,
    type: str,
    title: str,
    body: str = "",
    ref_id: Optional[str] = None,
) -> dict:
    """Gửi 1 thông báo tới đúng username (guest = `khach_<guest_id>` riêng)."""
    return STORE.append({
        "id": _new_id(),
        "user": user or "khach",
        "type": type if type in VALID_TYPES else "he_thong",
        "title": title[:200],
        "body": body[:2000],
        "ref_id": ref_id,
        "read": False,
        "created_at": now(),
    })


def _new_id() -> str:
    from uuid import uuid4
    return uuid4().hex[:12]


def broadcast_staff(
    *, type: str, title: str, body: str = "", ref_id: Optional[str] = None,
    exclude: Optional[str] = None,
) -> int:
    """Gửi thông báo tới tất cả cán bộ + admin đang có trong users.json."""
    from rag_api import auth  # import muộn — tránh vòng lặp

    sent = 0
    for u in auth.list_users():
        if u.get("role") not in auth.STAFF_ROLES:
            continue
        name = u.get("username")
        if exclude and name == exclude:
            continue
        add(user=name, type=type, title=title, body=body, ref_id=ref_id)
        sent += 1
    return sent


def for_user(user: str, unread_only: bool = False,
             limit: int = 50) -> list[dict]:
    rows = [r for r in STORE.all() if r.get("user") == user]
    if unread_only:
        rows = [r for r in rows if not r.get("read")]
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows[:limit]


def counts(user: str) -> dict:
    rows = for_user(user, limit=10000)
    return {
        "unread": sum(1 for r in rows if not r.get("read")),
        "total": len(rows),
    }


def mark_read(user: str, nid: str, read: bool = True) -> bool:
    hit = STORE.update(
        lambda r: r.get("user") == user and r.get("id") == nid,
        lambda r: r.update({"read": read}),
    )
    return hit is not None


def mark_all(user: str) -> int:
    rows = STORE.all()
    n = 0
    for r in rows:
        if r.get("user") == user and not r.get("read"):
            r["read"] = True
            n += 1
    if n:
        STORE.write_all(rows)
    return n
