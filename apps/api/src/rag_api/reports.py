"""
reports.py — Tổng hợp báo cáo cho quản trị (nghiệp vụ 6.0).

Gom từ D1 (lich_su), D3 (hang_cho), D4 (danh_gia), D5 (users),
tri thức đã duyệt và thông báo — không cần DB 13 bảng.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

from rag_api import auth, feedback as fb, hangcho as hq, history as hs
from rag_api import knowledge, notifications, reviews


def _day(ts: str | None) -> str:
    if not ts:
        return ""
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return ""


def build(days: int = 7) -> dict:
    hist = hs.stats()
    feed = fb.stats()
    queue = hq.counts()
    docs = knowledge.counts()
    rsw = reviews.counts()
    users = auth.list_users()

    with notifications.STORE.lock:
        notif_rows = notifications.STORE.all()
    with reviews.STORE.lock:
        review_rows = reviews.STORE.all()
    with hq._lock:
        queue_rows = hq._read_all()
    with hs._lock:
        hist_rows = hs._read_all()
    with fb._lock:
        feed_rows = fb._read_all()

    # ---- hoạt động theo ngày (D1 + D4 + D3) ----
    last = [(datetime.now(timezone.utc) - timedelta(days=i)).strftime("%Y-%m-%d")
            for i in range(days - 1, -1, -1)]
    h_by = Counter(_day(r.get("created_at")) for r in hist_rows)
    f_by = Counter(_day(r.get("created_at")) for r in feed_rows)
    q_by = Counter(_day(r.get("created_at")) for r in queue_rows)
    activity = [
        {"date": d, "messages": h_by.get(d, 0),
         "feedback": f_by.get(d, 0), "hang_cho": q_by.get(d, 0)}
        for d in last
    ]

    # ---- quyết định router (ANSWER / ASK_BACK / OUT_OF_SCOPE) ----
    decisions = Counter(
        (r.get("meta") or {}).get("decision") or "khong-ro"
        for r in hist_rows if r.get("role") == "assistant"
    )

    # ---- câu hỏi phổ biến ----
    questions = Counter(
        (r.get("content") or "").strip()[:160]
        for r in hist_rows if r.get("role") == "user" and r.get("content")
    )
    top_questions = [
        {"question": q, "n": n} for q, n in questions.most_common(8)
    ]

    # ---- hiệu suất cán bộ ----
    staff = Counter(
        (r.get("replied_by") or "chưa rõ")
        for r in queue_rows if r.get("status") == "da_tra_loi"
    )
    staff_replies = [
        {"name": k, "n": v} for k, v in staff.most_common(8)
    ]

    # ---- hàng rà soát chọn lọc ----
    pending_review = [
        {"id": r.get("id"), "question": (r.get("question") or "")[:160],
         "status": r.get("status"), "created_at": r.get("created_at")}
        for r in review_rows if r.get("status") in ("cho_rasoat", "da_rasoat")
    ][:10]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "overview": {
            "n_messages": hist["n_messages"],
            "n_sessions": hist["n_sessions"],
            "n_users": len(users),
            "n_roles": len({u.get("role") for u in users if u.get("role")}),
            "n_feedback": feed["n"],
            "avg_stars": feed["avg_stars"],
            "ratio_up": feed["ratio_up"],
            "hang_cho_pending": queue["cho_xu_ly"],
            "hang_cho_done": queue["da_tra_loi"],
            "docs_pending": docs["de_xuat"],
            "docs_approved": docs["da_duyet"],
            "review_pending": rsw.get("cho_rasoat", 0) + rsw.get("da_rasoat", 0),
            "review_approved": rsw.get("da_duyet", 0),
            "n_notifications": len(notif_rows),
        },
        "activity": activity,
        "decisions": [{"name": k, "n": v} for k, v in decisions.most_common()],
        "per_tag": feed["per_tag"],
        "recent_feedback": feed["recent"],
        "top_questions": top_questions,
        "staff_replies": staff_replies,
        "pending_review": pending_review,
    }
