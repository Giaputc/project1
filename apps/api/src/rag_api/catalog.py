"""
catalog.py — Danh mục Chủ đề / Phòng ban (kho D6, các bảng CHU_DE + PHONG_BAN).

23 hashtag trong tags.json là chủ đề gốc (không sửa được id). Admin có thể
đặt tên hiển thị, mô tả, phòng ban phụ trách cho từng chủ đề, và thêm chủ đề
mới (chưa gắn tag) để phân loại câu hỏi/hàng chờ.

JSON-lines tại data/chu_de.jsonl — 1 dòng = 1 tuỳ chỉnh/chủ đề mới.
"""

from __future__ import annotations

import json
from typing import Optional

from rag_api.store import JsonlStore, DATA_DIR

TAGS_FILE = DATA_DIR / "corpus" / "tags.json"
STORE = JsonlStore(DATA_DIR / "chu_de.jsonl")

DEFAULT_DEPARTMENT = "Phòng Công tác sinh viên"


def _base_topics() -> list[dict]:
    if not TAGS_FILE.exists():
        return []
    try:
        tags = json.loads(TAGS_FILE.read_text(encoding="utf-8")).get("tags", [])
    except Exception:
        return []
    return [
        {
            "id": t["id"],
            "name": t.get("hashtag") or t["id"],
            "description": t.get("description", "")[:300],
            "phong_ban": DEFAULT_DEPARTMENT,
            "tag_id": t["id"],
            "custom": False,
        }
        for t in tags if t.get("id")
    ]


def list_topics() -> list[dict]:
    overrides = {r.get("id"): r for r in STORE.all()}
    out = []
    for base in _base_topics():
        ov = overrides.pop(base["id"], None)
        if ov:
            out.append({**base,
                        "name": ov.get("name") or base["name"],
                        "description": ov.get("description") or base["description"],
                        "phong_ban": ov.get("phong_ban") or base["phong_ban"],
                        "custom": False})
        else:
            out.append(base)
    # chủ đề tự thêm (không có tag gốc)
    for ov in overrides.values():
        out.append({
            "id": ov.get("id"), "name": ov.get("name") or ov.get("id"),
            "description": ov.get("description") or "",
            "phong_ban": ov.get("phong_ban") or DEFAULT_DEPARTMENT,
            "tag_id": ov.get("tag_id") or ov.get("id"),
            "custom": True,
        })
    out.sort(key=lambda x: x.get("name") or "")
    return out


def get_topic(topic_id: str) -> Optional[dict]:
    return next((t for t in list_topics() if t.get("id") == topic_id), None)


def upsert(topic_id: str, patch: dict, create: bool = False) -> dict:
    """Sửa chủ đề có sẵn hoặc tạo mới. Trả bản ghi sau cập nhật."""
    import re
    if not re.fullmatch(r"[a-z0-9-]{2,64}", topic_id or ""):
        raise ValueError("id chủ đề: 2-64 ký tự a-z, 0-9, '-'")
    existing = get_topic(topic_id)
    if existing is None and not create:
        raise ValueError("Không tìm thấy chủ đề")
    if existing is not None and existing.get("custom") is False:
        # tag gốc: không cho đổi tag_id
        patch.pop("tag_id", None)
    rec = {
        "id": topic_id,
        "name": str(patch.get("name") or (existing or {}).get("name") or topic_id)[:120],
        "description": str(patch.get("description") or
                           (existing or {}).get("description") or "")[:1000],
        "phong_ban": str(patch.get("phong_ban") or
                         (existing or {}).get("phong_ban") or DEFAULT_DEPARTMENT)[:120],
        "tag_id": (existing or {}).get("tag_id") or patch.get("tag_id") or topic_id,
        "custom": bool((existing or {}).get("custom", create)),
    }
    STORE.delete(lambda r: r.get("id") == topic_id)
    STORE.append(rec)
    return rec


def delete(topic_id: str) -> bool:
    topic = get_topic(topic_id)
    if topic is None or not topic.get("custom"):
        return False  # chủ đề gốc (23 tag) không xoá được
    return STORE.delete(lambda r: r.get("id") == topic_id) > 0
