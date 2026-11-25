"""
knowledge.py — Quản lý tri thức bổ sung (kho TAI_LIEU / D3 → D2).

Luồng nghiệp vụ 5.0 + "học từ phản hồi" (sơ đồ Activity):
  cán bộ đề xuất tài liệu → admin phê duyệt → chunk mới có embedding +
  chỉ mục trong D2 (rag_engine tiêm vào loaders, không ghi đè chunks.jsonl
  của rebuild.py).

Câu trả lời được admin phê duyệt (rag_api/reviews.py) cũng đi vào cùng kho
với kind="tra_loi" để AI tái dùng.

JSON-lines tại data/tri_thuc.jsonl.
"""

from __future__ import annotations

from typing import Optional

from rag_api.store import JsonlStore, DATA_DIR, now

STORE = JsonlStore(DATA_DIR / "tri_thuc.jsonl")

VALID_STATUS = {"de_xuat", "da_duyet", "tu_choi"}
VALID_KIND = {"tai_lieu", "tra_loi"}


def _new_id() -> str:
    from uuid import uuid4
    return uuid4().hex[:12]


def propose_doc(
    *,
    title: str,
    text: str,
    tag: Optional[str] = None,
    source: Optional[str] = None,
    user: Optional[str] = None,
    display: Optional[str] = None,
) -> dict:
    """Cán bộ/admin đề xuất tài liệu — chờ admin phê duyệt."""
    t = (title or "").strip()
    body = (text or "").strip()
    if not t or not body:
        raise ValueError("title và text là bắt buộc")
    return STORE.append({
        "id": _new_id(),
        "kind": "tai_lieu",
        "title": t[:200],
        "text": body[:8000],
        "tag": (tag or "").strip()[:64] or None,
        "source": (source or "").strip()[:300] or None,
        "proposed_by": user,
        "proposed_display": display,
        "status": "de_xuat",
        "reviewed_by": None,
        "review_note": None,
        "ref_id": None,
        "created_at": now(),
        "reviewed_at": None,
    })


def add_approved(
    *,
    kind: str,
    title: str,
    text: str,
    tag: Optional[str] = None,
    user: Optional[str] = None,
    ref_id: Optional[str] = None,
    note: Optional[str] = None,
) -> dict:
    """Đưa nội dung đã được phê duyệt vào kho tri thức (hiệu lực sau reload)."""
    if kind not in VALID_KIND:
        raise ValueError("kind không hợp lệ")
    body = (text or "").strip()
    if not body:
        raise ValueError("text là bắt buộc")
    return STORE.append({
        "id": _new_id(),
        "kind": kind,
        "title": (title or "").strip()[:200],
        "text": body[:8000],
        "tag": (tag or "").strip()[:64] or None,
        "source": None,
        "proposed_by": user,
        "proposed_display": None,
        "status": "da_duyet",
        "reviewed_by": user,
        "review_note": (note or "").strip()[:1000] or None,
        "ref_id": ref_id,
        "created_at": now(),
        "reviewed_at": now(),
    })


def items(status: Optional[str] = None, kind: Optional[str] = None,
          limit: int = 200) -> list[dict]:
    rows = STORE.all()
    if status:
        rows = [r for r in rows if r.get("status") == status]
    if kind:
        rows = [r for r in rows if r.get("kind") == kind]
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows[:limit]


def get(entry_id: str) -> Optional[dict]:
    return STORE.find(lambda r: r.get("id") == entry_id)


def review(entry_id: str, action: str, reviewer: str,
           note: Optional[str] = None) -> Optional[dict]:
    """admin duyệt / từ chối tài liệu đề xuất."""
    if action not in ("duyet", "tu_choi"):
        raise ValueError("action phải là 'duyet' hoặc 'tu_choi'")
    hit = STORE.update(
        lambda r: r.get("id") == entry_id and r.get("status") == "de_xuat",
        lambda r: r.update({
            "status": "da_duyet" if action == "duyet" else "tu_choi",
            "reviewed_by": reviewer,
            "review_note": (note or "").strip()[:1000] or None,
            "reviewed_at": now(),
        }),
    )
    if hit is not None:
        _notify_owner(hit, action, reviewer)
    return hit


def _notify_owner(entry: dict, action: str, reviewer: str) -> None:
    owner = entry.get("proposed_by")
    if not owner:
        return
    from rag_api import notifications as nt
    label = "đã được phê duyệt" if action == "duyet" else "bị từ chối"
    nt.add(user=owner, type="tai_lieu_duyet",
           title=f"Tài liệu {label}",
           body=f"“{entry.get('title', '')}” — {reviewer}",
           ref_id=entry.get("id"))


def counts() -> dict:
    rows = STORE.all()
    return {
        "de_xuat": sum(1 for r in rows if r.get("status") == "de_xuat"),
        "da_duyet": sum(1 for r in rows if r.get("status") == "da_duyet"),
        "tu_choi": sum(1 for r in rows if r.get("status") == "tu_choi"),
        "tong": len(rows),
    }


def approved_chunks() -> list[dict]:
    """Chunk từ nội dung đã duyệt — rag_engine nạp thêm vào D2 khi load."""
    out: list[dict] = []
    for r in STORE.all():
        if r.get("status") != "da_duyet":
            continue
        tag = r.get("tag") or None
        text = (r.get("text") or "").strip()
        if not text:
            continue
        out.append({
            "id": f"TL-{r['id']}",
            "page_start": 0,
            "page_end": 0,
            "heading": {"dieu": r.get("title") or "Tri thức bổ sung"},
            "tags": [tag] if tag else [],
            "tag_primary": tag,
            "text": text,
            "source_kind": r.get("kind"),
            "source_ref": r.get("id"),
        })
    return out
