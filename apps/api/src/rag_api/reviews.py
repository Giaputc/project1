"""
reviews.py — Rà soát chuyên môn & phê duyệt câu trả lời (nghiệp vụ 4.0/D4).

"Câu trả lời tốt được sinh viên đánh giá, cán bộ rà soát, quản trị viên
phê duyệt rồi đưa ngược vào cơ sở tri thức để AI ngày càng chính xác hơn."

Tự động đưa vào hàng rà soát khi feedback: vote=up VÀ so_sao>=4.
Cán bộ: đọc đánh giá (sao/nhận xét) của sinh viên, đánh giá \"có hữu ích hay
không\" rồi mới trình admin (da_rasoat). Admin: duyệt → knowledge.add_approved
(kind='tra_loi') → sau /api/corpus/reload AI dùng được đáp án này.
Cán bộ chọn \"không hữu ích\" → status `khong_huu_ich`, admin không thấy.

JSON-lines tại data/ra_soat.jsonl.
"""

from __future__ import annotations

from typing import Optional

from rag_api.store import JsonlStore, DATA_DIR, now

STORE = JsonlStore(DATA_DIR / "ra_soat.jsonl")

VALID_STATUS = {"cho_rasoat", "da_rasoat", "da_duyet", "tu_choi", "khong_huu_ich"}
AUTO_THRESHOLD = 4  # sao


def _new_id() -> str:
    from uuid import uuid4
    return uuid4().hex[:12]


def enqueue_from_feedback(rec: dict, force: bool = False) -> Optional[dict]:
    """Đưa đáp án được đánh giá vào hàng rà soát (1 lần / answer_id).

    Mặc định chỉ lấy vote=up & >=4 sao; `force=True` cho cán bộ tự đưa vào.
    """
    if not force and (
        rec.get("vote") != "up" or int(rec.get("so_sao") or 0) < AUTO_THRESHOLD
    ):
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
        "feedback_display": rec.get("display"),
        "so_sao": rec.get("so_sao"),
        "vote": rec.get("vote"),
        "nhan_xet": rec.get("nhan_xet"),
        "staff_verdict": None,
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
        "feedback_display": None,
        "so_sao": None,
        "vote": None,
        "nhan_xet": None,
        "staff_verdict": None,
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
           edited_answer: Optional[str] = None,
           huu_ich: bool = True) -> Optional[dict]:
    """Cán bộ đánh giá đáp án sau khi đọc feedback của sinh viên.

    huu_ich=True  → da_rasoat, trình admin phê duyệt.
    huu_ich=False → khong_huu_ich, dừng ở cán bộ (admin không thấy).
    """
    verdict = "huu_ich" if huu_ich else "khong_huu_ich"
    return STORE.update(
        lambda r: r.get("id") == item_id
        and r.get("status") in ("cho_rasoat", "da_rasoat"),
        lambda r: r.update({
            "status": "da_rasoat" if huu_ich else "khong_huu_ich",
            "final_answer": ((edited_answer or "").strip()[:8000]
                             or r.get("answer")) if huu_ich else r.get("final_answer"),
            "note": (note or "").strip()[:1000] or None,
            "staff_verdict": verdict,
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
