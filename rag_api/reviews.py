"""
reviews.py — Rà soát chuyên môn & phê duyệt câu trả lời (nghiệp vụ 4.0/D4).

"Câu trả lời tốt được sinh viên đánh giá, cán bộ rà soát, quản trị viên
phê duyệt rồi đưa ngược vào cơ sở tri thức để AI ngày càng chính xác hơn."

Tự động đưa vào hàng rà soát khi feedback: vote=up VÀ so_sao>=4.
Cán bộ: đọc + sửa đáp án (da_rasoat). Admin: duyệt → knowledge.add_approved
(kind='tra_loi') → sau /api/corpus/reload AI dùng được đáp án này.

JSON-lines tại data/ra_soat.jsonl.
"""

from __future__ import annotations

from typing import Optional

from rag_api.store import JsonlStore, DATA_DIR, now

STORE = JsonlStore(DATA_DIR / "ra_soat.jsonl")

VALID_STATUS = {"cho_rasoat", "da_rasoat", "da_duyet", "tu_choi"}
AUTO_THRESHOLD = 4  # sao


def _new_id() -> str:
    from uuid import uuid4
    return uuid4().hex[:12]


def enqueue_from_feedback(rec: dict) -> Optional[dict]:
    """Đưa đáp án được đánh giá cao vào hàng rà soát (1 lần / answer_id)."""
    if rec.get("vote") != "up" or int(rec.get("so_sao") or 0) < AUTO_THRESHOLD:
        return None
    aid = rec.get("answer_id")
    if aid and STORE.find(lambda r: r.get("answer_id") == aid):
        return None
    text = (rec.get("answer") or rec.get("answer_preview") or "").strip()
    if not text:
        return None
    return STORE.append({
        "id": _new_id(),
        "answer_id": aid,
        "feedback_id": rec.get("id"),
        "feedback_user": rec.get("user"),
        "question": (rec.get("question") or "")[:2000],
        "answer": text[:8000],
        "final_answer": None,
        "tag": rec.get("tag"),
        "sources": rec.get("sources") or [],
        "status": "cho_rasoat",
        "note": None,
        "reviewer": None,
        "approved_by": None,
        "created_at": now(),
        "reviewed_at": None,
        "decided_at": None,
    })


def add_manual(*, question: str, answer: str, tag: Optional[str] = None,
               user: Optional[str] = None) -> dict:
    """Cán bộ thêm thủ công 1 đáp án cần rà soát."""
    q, a = (question or "").strip(), (answer or "").strip()
    if not q or not a:
        raise ValueError("question và answer là bắt buộc")
    return STORE.append({
        "id": _new_id(),
        "answer_id": None,
        "feedback_id": None,
        "feedback_user": user,
        "question": q[:2000],
        "answer": a[:8000],
        "final_answer": None,
        "tag": tag,
        "sources": [],
        "status": "cho_rasoat",
        "note": None,
        "reviewer": None,
        "approved_by": None,
        "created_at": now(),
        "reviewed_at": None,
        "decided_at": None,
    })


def items(status: Optional[str] = None, limit: int = 200) -> list[dict]:
    rows = STORE.all()
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows[:limit]


def get(item_id: str) -> Optional[dict]:
    return STORE.find(lambda r: r.get("id") == item_id)


def review(item_id: str, reviewer: str, note: Optional[str] = None,
           edited_answer: Optional[str] = None) -> Optional[dict]:
    """Cán bộ rà soát chuyên môn — có thể sửa đáp án trước khi trình admin."""
    return STORE.update(
        lambda r: r.get("id") == item_id
        and r.get("status") in ("cho_rasoat", "da_rasoat"),
        lambda r: r.update({
            "status": "da_rasoat",
            "final_answer": (edited_answer or "").strip()[:8000]
            or r.get("answer"),
            "note": (note or "").strip()[:1000] or None,
            "reviewer": reviewer,
            "reviewed_at": now(),
        }),
    )


def decide(item_id: str, action: str, approver: str,
           note: Optional[str] = None) -> Optional[dict]:
    """Admin phê duyệt / từ chối. Duyệt → đưa ngược vào cơ sở tri thức."""
    if action not in ("duyet", "tu_choi"):
        raise ValueError("action phải là 'duyet' hoặc 'tu_choi'")
    hit = STORE.update(
        lambda r: r.get("id") == item_id and r.get("status") == "da_rasoat",
        lambda r: r.update({
            "status": "da_duyet" if action == "duyet" else "tu_choi",
            "approved_by": approver,
            "note": (note or "").strip()[:1000] or r.get("note"),
            "decided_at": now(),
        }),
    )
    if hit is None:
        return None

    if action == "duyet":
        from rag_api import knowledge
        knowledge.add_approved(
            kind="tra_loi",
            title=hit.get("question") or "Câu trả lời được phê duyệt",
            text=hit.get("final_answer") or hit.get("answer") or "",
            tag=hit.get("tag"),
            user=approver,
            ref_id=hit.get("id"),
            note=note,
        )

    owner = hit.get("feedback_user")
    if owner:
        from rag_api import notifications as nt
        label = "đã được phê duyệt" if action == "duyet" else "bị từ chối"
        nt.add(user=owner, type="tra_loi_duyet",
               title=f"Đánh giá của bạn {label}",
               body=(hit.get("question") or "")[:180],
               ref_id=hit.get("id"))
    return hit


def counts() -> dict:
    rows = STORE.all()
    return {s: sum(1 for r in rows if r.get("status") == s)
            for s in VALID_STATUS} | {"tong": len(rows)}
