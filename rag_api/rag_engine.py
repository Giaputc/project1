"""
rag_engine.py
Wrapper tái sử dụng pipeline RAG từ demo_ollama.py cho FastAPI.

- KHÔNG copy logic RAG: import thẳng từ demo_ollama (score_tags, decide,
  retrieve, build_context, build_messages, chat, embed, load_all).
- Load corpus + embed cache MỘT LẦN (singleton, thread-safe).
- Trả về dữ liệu đã cấu trúc cho frontend (decision, scores, sources, stats).
- Các tham số runtime (model, temperature, topk, ...) set qua global của
  demo_ollama trước mỗi request — pipeline giữ nguyên hành vi như CLI.

Yêu cầu: Ollama chạy tại localhost:11434.
"""

from __future__ import annotations

import json
import sys
import re
import threading
import time
from pathlib import Path
from typing import Any, Generator, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import demo_ollama as de  # noqa: E402  (pipeline gốc — không sửa)

import numpy as np  # noqa: E402

CORPUS = ROOT / "data" / "corpus"
TAGS_FILE = CORPUS / "tags.json"                    # 23 tag (description/synonyms/examples)
TAGS_MANUAL_FILE = CORPUS / "tags_manual.json"      # tag ADMIN gán tay theo chunk

# ---------------------------------------------------------------
# Tham số runtime (mặc định = demo_ollama.py)
# ---------------------------------------------------------------
DEFAULT_PARAMS: dict[str, Any] = {
    "model": de.CHAT_MODEL,        # qwen2.5:3b-instruct
    "temperature": 0.2,
    "max_tokens": de.MAX_TOKENS,   # 280
    "topk": de.TOPK,               # 1
    "rrf_k": 60,
    "tag_boost": 1.5,
    "margin_ask": de.MARGIN_ASK,   # 0.08
    "score_low": de.SCORE_LOW,     # 0.30
    "keep_alive": de.KEEP_ALIVE,   # 24h
    "use_llm": True,
}

_lock = threading.Lock()          # tuần tự hoá request (global state của demo_ollama)
_load_lock = threading.Lock()
_state: dict[str, Any] = {
    "loaders": None, "loaded": False, "load_error": None,
    "exemplars": {},              # {tag_id: np.array (n_ex, d)} — embed câu ví dụ
}

# ---------------------------------------------------------------
# TAG THỦ CÔNG (admin gán tay theo chunk) — sống riêng, survive rebuild
# ---------------------------------------------------------------
def _load_manual() -> dict[str, list[str]]:
    if TAGS_MANUAL_FILE.exists():
        try:
            return json.loads(TAGS_MANUAL_FILE.read_text(encoding="utf-8"))["chunks"]
        except Exception:
            return {}
    return {}


def _save_manual(m: dict[str, list[str]]) -> None:
    TAGS_MANUAL_FILE.write_text(
        json.dumps({"chunks": m}, ensure_ascii=False, indent=2),
        encoding="utf-8")


def _merge_manual_tags(chunks: list) -> None:
    """Áp tag admin gán tay lên chunks (ghi đè tag rule). Chunk bất biến có
    tags_rule để admin reset về rule."""
    manual = _load_manual()
    for c in chunks:
        c["tags_rule"] = list(c.get("tags") or [])
        mid = manual.get(c["id"])
        if mid is not None:
            c["tags"] = list(mid)
            c["tag_primary"] = mid[0] if mid else None
        c["tags_manual"] = c["id"] in manual


# ---------------------------------------------------------------
# EXEMPLARS — routing theo câu ví dụ (admin sửa được)
# ---------------------------------------------------------------
def _load_exemplars(tags: list) -> dict[str, Any]:
    """Embed câu ví dụ của tag (description không đổi — dùng cache mô tả).
    Cache riêng tag_exemplar_embeds: {tag_id: [vector, ...]}."""
    cache = de.load_cache("tag_exemplar_embeds")
    changed = False
    out: dict[str, np.ndarray] = {}
    for t in tags:
        exs = [e.strip() for e in (t.get("examples") or []) if e.strip()]
        missing = [e for e in exs
                   if e not in {row[0] for row in cache.get(t["id"], [])}]
        if missing:
            vecs = de.embed(missing)
            rows = cache.setdefault(t["id"], [])
            for e, v in zip(missing, vecs):
                rows.append([e, v.tolist()])
            changed = True
        if exs:
            rows = [r[1] for r in cache.get(t["id"], []) if r[0] in exs]
            if rows:
                m = np.asarray(rows, dtype=np.float32)
                out[t["id"]] = m
    if changed:
        de.save_cache("tag_exemplar_embeds", cache)
    return out


def score_tags_ext(q_vec: np.ndarray, tags: list, tag_mat: np.ndarray,
                   exemplars: dict[str, Any]) -> list:
    """Chấm điểm tag: max(cos với mô tả+synonyms, max(cos với exemplar)).
    Thay de.score_tags — cùng output [(tag_id, score)] giảm dần."""
    sims = tag_mat @ q_vec
    for tag_id, mat in exemplars.items():
        idx = [i for i, t in enumerate(tags) if t["id"] == tag_id]
        if idx:
            ex_best = float((mat @ q_vec).max())
            i = idx[0]
            sims[i] = max(float(sims[i]), ex_best)
    order = np.argsort(-sims)
    return [(tags[i]["id"], float(sims[i])) for i in order]


# ---------------------------------------------------------------
# Load corpus (1 lần)
# ---------------------------------------------------------------
def ensure_loaded(blocking: bool = True) -> bool:
    """Load corpus + embed cache nếu chưa có. Trả về True nếu đã sẵn sàng."""
    if _state["loaded"]:
        return True
    if not blocking:
        return False
    with _load_lock:
        if _state["loaded"]:
            return True
        try:
            t0 = time.time()
            loaders = de.load_all()
            _merge_manual_tags(loaders[0])          # tag admin gán tay (ghi đè rule)
            _state["loaders"] = loaders
            _state["exemplars"] = _load_exemplars(loaders[1])
            _state["loaded"] = True
            _state["load_error"] = None
            _state["load_seconds"] = round(time.time() - t0, 2)
            return True
        except Exception as e:  # Ollama chết / cache hỏng / file thiếu
            _state["load_error"] = f"{type(e).__name__}: {e}"
            return False


def is_loaded() -> bool:
    return bool(_state["loaded"])


def reload_corpus() -> dict[str, Any]:
    """Nạp lại corpus + cache embed từ disk — dùng sau khi rebuild.py cập nhật
    dữ liệu. Request đang chạy vẫn an toàn (giữ ref cũ tới khi xong)."""
    with _load_lock:                      # chỉ reset state, KHÔNG gọi ensure_loaded trong lock
        _state["loaders"] = None
        _state["loaded"] = False
        _state["load_error"] = None
        _state["exemplars"] = {}
    t0 = time.time()
    ok = ensure_loaded(blocking=True)     # lấy _load_lock bên ngoài — không deadlock
    return {"loaded": ok, "error": _state["load_error"],
            "seconds": round(time.time() - t0, 2)}


def load_error() -> Optional[str]:
    return _state["load_error"]


# ---------------------------------------------------------------
# Áp params → global của demo_ollama
# ---------------------------------------------------------------
def _apply_params(p: dict[str, Any]) -> dict[str, Any]:
    params = {**DEFAULT_PARAMS, **{k: v for k, v in p.items() if v is not None}}
    de.CHAT_MODEL = str(params["model"])
    de.TOPK = int(params["topk"])
    de.MAX_TOKENS = int(params["max_tokens"])
    de.KEEP_ALIVE = str(params["keep_alive"])
    de.MARGIN_ASK = float(params["margin_ask"])
    de.SCORE_LOW = float(params["score_low"])
    return params


# ---------------------------------------------------------------
# Pipeline 1 câu hỏi — generator (stream)
# ---------------------------------------------------------------
# Tag hợp lệ (từ tags.json) — validate force_tag
def valid_tag_ids() -> set[str]:
    if not ensure_loaded():
        return set()
    _chunks, tags, *_ = _state["loaders"]
    return {t["id"] for t in tags}


def _scoped_hits(question: str, q_vec, force_tag: str, chunks: list,
                 ch_mat, bm25, k: int, rrf_k: int) -> list:
    """Retrieve STRICT theo tag user chọn: chỉ xét chunk mang force_tag,
    xếp hạng RRF (BM25 + vector) như pipeline gốc. Trả [] nếu tag không
    có chunk nào (caller fallback về retrieve thường)."""
    bm25_scores = bm25.get_scores(re.findall(r"\w+", question.lower()))
    rank_bm25 = np.argsort(np.argsort(-bm25_scores))
    rank_vec = np.argsort(np.argsort(-(ch_mat @ q_vec)))
    rrf = 1 / (rrf_k + rank_bm25) + 1 / (rrf_k + rank_vec)
    scoped = [i for i, c in enumerate(chunks) if force_tag in (c.get("tags") or [])]
    if not scoped:
        return []
    scoped.sort(key=lambda i: -rrf[i])
    return [(int(i), float(rrf[i])) for i in scoped[:k]]


def ask_stream(question: str, params: Optional[dict] = None,
               force_tag: Optional[str] = None
               ) -> Generator[dict[str, Any], None, None]:
    """Chạy pipeline RAG, sinh ra event:
       {"type":"meta",  ...}  — scores/decision/sources/prompt (TRƯỚC khi LLM chạy)
       {"type":"token", ...}  — 1 mẩu text từ LLM (chỉ khi use_llm)
       {"type":"done",  ...}  — stats/timing tổng kết

    force_tag: tag người dùng CHỌN THỦ CÔNG khi câu hỏi mơ hồ → bypass
    quyết định theo ngưỡng, retrieve scoped theo tag đó.
    """
    if not ensure_loaded():
        yield {"type": "error", "message": f"Chưa nạp được corpus: {_state['load_error']}"}
        return

    with _lock:
        p = _apply_params(params or {})
        chunks, tags, tag_mat, ch_mat, bm25 = _state["loaders"]
        valid_tags = {t["id"] for t in tags}
        t0 = time.time()

        # [0] Nhận diện hashtag trong câu hỏi nếu user gõ kèm (vd: "... #don-vi-cong-tac-sinh-vien")
        search_question = question
        extracted_from_text = None
        if not force_tag:
            clean_q, extracted_from_text = de.extract_hashtag(question, tags)
            if extracted_from_text:
                force_tag = extracted_from_text
                search_question = clean_q

        # [1] embed câu hỏi (dùng câu hỏi đã bỏ hashtag)
        try:
            q_vec = de.embed([search_question])[0]
        except Exception as e:
            yield {"type": "error", "message": f"Lỗi embed (Ollama?): {type(e).__name__}: {e}"}
            return

        # [2] chấm điểm tag — max(cos mô tả, max cos exemplar)
        scores = score_tags_ext(q_vec, tags, tag_mat, _state["exemplars"])
        scores_out = [{"tag": t, "score": round(float(s), 4)} for t, s in scores[:5]]

        # [3] quyết định
        forced: Optional[str] = None
        if force_tag:
            if force_tag not in valid_tags:
                yield {"type": "error",
                       "message": f"force_tag '{force_tag}' không phải tag hợp lệ"}
                return
            forced = force_tag
            auto_top, auto_score = scores[0]
            decision = "ANSWER"
            if extracted_from_text:
                why = (f"nhận diện hashtag #{forced} trong câu hỏi "
                       f"(điểm tự động: #{auto_top}={auto_score:.3f})")
            else:
                why = (f"user chọn thủ công #{forced} (tự động chọn trước đó: "
                       f"#{auto_top}={auto_score:.3f})")
        else:
            decision, why = de.decide(scores)

        # [4] hybrid retrieve — scoped theo tag user chọn (nếu có) hoặc top-1
        top_tag = forced or scores[0][0]
        hits, global_top = de.retrieve(
            search_question, q_vec, top_tag, chunks, ch_mat, bm25,
            k=int(p["topk"]), rrf_k=int(p["rrf_k"]), tag_boost=float(p["tag_boost"]))

        # user chọn tag thủ công hoặc gõ hashtag kèm theo → STRICT scope: chỉ chunk mang tag đó
        strict_forced = False
        if forced:
            scoped = _scoped_hits(search_question, q_vec, forced, chunks, ch_mat, bm25,
                                  k=int(p["topk"]), rrf_k=int(p["rrf_k"]))
            if scoped:
                hits = scoped
                strict_forced = True
            # nếu tag không có chunk nào → giữ hits fallback (retrieve thường)

        # [5] build prompt (dùng search_question sạch)
        context, used = de.build_context(hits, chunks)
        messages = de.build_messages(context, search_question, de.USER_TEMPLATE)

        def _chunk_src(rank: int, idx: int, rrf: float) -> dict[str, Any]:
            c = chunks[idx]
            h = c.get("heading") or {}
            return {
                "rank": rank,
                "id": c["id"],
                "page_start": c["page_start"],
                "page_end": c["page_end"],
                "tags": c.get("tags") or [],
                "tag_primary": c.get("tag_primary"),
                "heading": h.get("dieu") or h.get("muc") or h.get("chuong") or h.get("phan") or "",
                "rrf": round(float(rrf), 4),
                "text": c["text"],
            }

        sources = [_chunk_src(i, idx, sc) for i, (idx, sc) in enumerate(hits, 1)]

        yield {
            "type": "meta",
            "question": question,
            "decision": decision,
            "why": why,
            "top_tag": top_tag,
            "forced_tag": forced,
            "strict_scope": strict_forced,
            "scores": scores_out,
            "ask_back": {
                "question": question,
                "options": [t for t, _ in scores[:3]],
            } if decision == "ASK_BACK" else None,
            "sources": sources,
            "global_fallback": [chunks[i]["id"] for i in global_top
                                if i not in {h[0] for h in hits}],
            "prompt": messages[1]["content"],
            "system_prompt": messages[0]["content"],
            "params": {k: p[k] for k in ("model", "temperature", "max_tokens", "topk",
                                          "rrf_k", "tag_boost", "margin_ask",
                                          "score_low", "use_llm")},
            "elapsed_s": round(time.time() - t0, 2),
        }

        # Câu mơ hồ (ASK_BACK) → DỪNG trước LLM, chờ user chọn hashtag;
        # OUT_OF_SCOPE → không gọi LLM; use_llm=false → chỉ xem tag/nguồn
        if decision == "ASK_BACK":
            yield {"type": "done",
                   "answer": None,
                   "stats": None,
                   "elapsed_s": round(time.time() - t0, 2),
                   "skipped_llm": True,
                   "reason": "chờ bạn chọn hashtag trước khi trả lời"}
            return
        if decision == "OUT_OF_SCOPE" or not p["use_llm"]:
            yield {"type": "done",
                   "answer": None,
                   "stats": None,
                   "elapsed_s": round(time.time() - t0, 2),
                   "skipped_llm": True,
                   "reason": ("decision=OUT_OF_SCOPE" if decision == "OUT_OF_SCOPE"
                              else "use_llm=false")}
            return

        # [6] stream LLM
        answer_parts: list[str] = []
        try:
            stream = de.chat(messages, stream=True,
                             temperature=float(p["temperature"]),
                             num_predict=int(p["max_tokens"]))
            for piece in stream:
                answer_parts.append(piece)
                yield {"type": "token", "text": piece}
        except Exception as e:
            yield {"type": "error", "message": f"Lỗi gọi LLM: {type(e).__name__}: {e}"}
            return

        stats = dict(de._LAST_STATS)   # timing ở chunk "done" cuối từ Ollama
        stats["cold_start"] = stats.get("load_ms", 0) > 2000
        stats["truncated"] = stats.get("out_tokens", 0) >= int(p["max_tokens"])
        yield {"type": "done",
               "answer": "".join(answer_parts),
               "stats": stats,
               "elapsed_s": round(time.time() - t0, 2),
               "skipped_llm": False}


def ask(question: str, params: Optional[dict] = None,
        force_tag: Optional[str] = None) -> dict[str, Any]:
    """Không stream — gộp mọi event thành 1 dict JSON."""
    meta: dict[str, Any] = {}
    tokens: list[str] = []
    done: dict[str, Any] = {}
    error: Optional[str] = None
    for ev in ask_stream(question, params, force_tag=force_tag):
        t = ev.get("type")
        if t == "meta":
            meta = ev
        elif t == "token":
            tokens.append(ev["text"])
        elif t == "done":
            done = ev
        elif t == "error":
            error = ev["message"]
    if error and not meta:
        raise RuntimeError(error)
    meta.pop("type", None)
    done.pop("type", None)
    return {"ok": error is None, "error": error, **meta, **done,
            "answer": done.get("answer") or ("".join(tokens) or None)}


# ---------------------------------------------------------------
# Preheat — nạp model vào RAM (chuyển cold start về lúc bấm nút)
# ---------------------------------------------------------------
def preheat(model: Optional[str] = None) -> dict[str, Any]:
    if not ensure_loaded():
        return {"ok": False, "message": f"Chưa nạp được corpus: {_state['load_error']}"}
    with _lock:
        _apply_params({"model": model} if model else {})
        t0 = time.time()
        try:
            de.chat([{"role": "user", "content": "oke"}], stream=False)
            dt = round(time.time() - t0, 1)
            return {"ok": True, "model": de.CHAT_MODEL, "seconds": dt,
                    "cold_start": dt > 5}
        except Exception as e:
            return {"ok": False, "model": de.CHAT_MODEL,
                    "message": f"{type(e).__name__}: {e}"}


# ===============================================================
# ADMIN: tag thủ công theo chunk + sửa định nghĩa tag (routing)
# ===============================================================
def admin_list_tags() -> list[dict[str, Any]]:
    """23+ tag: định nghĩa + số chunk đang mang (kể cả gán tay)."""
    if not ensure_loaded():
        raise RuntimeError(_state["load_error"] or "corpus chưa nạp")
    chunks, tags, *_ = _state["loaders"]
    manual = _load_manual()
    out = []
    for t in tags:
        n_rule = sum(1 for c in chunks if t["id"] in c.get("tags_rule", []))
        n_now = sum(1 for c in chunks if t["id"] in (c.get("tags") or []))
        out.append({
            **t,
            "examples": t.get("examples", []),
            "n_chunks_rule": n_rule,
            "n_chunks_now": n_now,
        })
    return out


def admin_list_chunks(q: Optional[str] = None, limit: int = 300) -> list[dict]:
    """Danh sách chunk cho admin (tìm kiếm theo id/heading/text)."""
    if not ensure_loaded():
        raise RuntimeError(_state["load_error"] or "corpus chưa nạp")
    chunks, *_ = _state["loaders"]
    ql = (q or "").lower().strip()
    out = []
    for c in chunks:
        h = c.get("heading") or {}
        heading = h.get("dieu") or h.get("muc") or h.get("chuong") or h.get("phan") or ""
        if ql and ql not in c["id"].lower() and ql not in heading.lower() \
                and ql not in c["text"].lower():
            continue
        out.append({
            "id": c["id"],
            "page_start": c["page_start"], "page_end": c["page_end"],
            "heading": heading,
            "tags": c.get("tags") or [],
            "tags_rule": c.get("tags_rule") or [],
            "tags_manual": bool(c.get("tags_manual")),
            "text_preview": c["text"][:160],
        })
        if len(out) >= limit:
            break
    return out


def _apply_manual_to_live(chunk_id: str, tags: Optional[list[str]]) -> None:
    """Cập nhật tag 1 chunk ngay trên state đang chạy (không cần reload)."""
    with _lock:
        chunks, *_ = _state["loaders"]
        for c in chunks:
            if c["id"] == chunk_id:
                if tags is None:                # khôi phục rule
                    c["tags"] = list(c.get("tags_rule") or [])
                    c["tags_manual"] = False
                else:
                    c["tags"] = list(tags)
                    c["tags_manual"] = True
                c["tag_primary"] = c["tags"][0] if c["tags"] else None
                return
    raise RuntimeError(f"Không tìm thấy chunk {chunk_id}")


def admin_set_chunk_tags(chunk_id: str, tags: list[str]) -> dict:
    """Gán tag tay cho 1 chunk — ghi đè rule, lưu tags_manual.json."""
    if not ensure_loaded():
        raise RuntimeError(_state["load_error"] or "corpus chưa nạp")
    valid = valid_tag_ids()
    bad = [t for t in tags if t not in valid]
    if bad:
        raise ValueError(f"Tag không tồn tại: {bad}")
    chunks, *_ = _state["loaders"]
    if chunk_id not in {c["id"] for c in chunks}:
        raise ValueError(f"Không có chunk {chunk_id}")
    manual = _load_manual()
    manual[chunk_id] = list(tags)
    _save_manual(manual)
    _apply_manual_to_live(chunk_id, tags)
    return {"chunk_id": chunk_id, "tags": tags, "saved": True}


def admin_reset_chunk_tags(chunk_id: str) -> dict:
    """Bỏ tag tay → khôi phục tag rule."""
    if not ensure_loaded():
        raise RuntimeError(_state["load_error"] or "corpus chưa nạp")
    manual = _load_manual()
    if chunk_id not in manual:
        raise ValueError(f"Chunk {chunk_id} không có tag tay")
    del manual[chunk_id]
    _save_manual(manual)
    _apply_manual_to_live(chunk_id, None)
    chunks, *_ = _state["loaders"]
    rule = next((c.get("tags_rule") for c in chunks if c["id"] == chunk_id), [])
    return {"chunk_id": chunk_id, "tags": list(rule or []), "reset": True}


# ---------- Sửa định nghĩa tag (description / synonyms / examples) ----------
def _write_tags_doc(mutate) -> None:
    doc = json.loads(TAGS_FILE.read_text(encoding="utf-8"))
    mutate(doc["tags"])
    TAGS_FILE.write_text(json.dumps(doc, ensure_ascii=False, indent=2),
                         encoding="utf-8")


def _drop_tag_caches(tag_id: str) -> None:
    """Xóa cache embed của tag (mô tả + exemplars) để lần load sau re-embed."""
    for name in ("tag_embeds", "tag_exemplar_embeds"):
        cache = de.load_cache(name)
        if tag_id in cache:
            del cache[tag_id]
            de.save_cache(name, cache)


def admin_update_tag(tag_id: str, description: Optional[str] = None,
                     synonyms: Optional[list[str]] = None,
                     examples: Optional[list[str]] = None) -> dict:
    """Sửa định nghĩa 1 tag → re-embed + reload → routing áp dụng ngay."""
    if not ensure_loaded():
        raise RuntimeError(_state["load_error"] or "corpus chưa nạp")

    def mutate(tags: list) -> None:
        t = next((x for x in tags if x["id"] == tag_id), None)
        if t is None:
            raise ValueError(f"Không có tag {tag_id}")
        if description is not None:
            t["description"] = description
        if synonyms is not None:
            t["synonyms"] = synonyms
        if examples is not None:
            t["examples"] = examples

    _write_tags_doc(mutate)
    _drop_tag_caches(tag_id)
    r = reload_corpus()
    if not r["loaded"]:
        raise RuntimeError(r["error"])
    return {"tag": tag_id, "updated": True}


def admin_add_tag(tag_id: str, description: str,
                  synonyms: Optional[list[str]] = None,
                  examples: Optional[list[str]] = None) -> dict:
    """Thêm tag mới (vd #nop-hoc-phi-khac) — routing theo description/exemplars."""
    if not ensure_loaded():
        raise RuntimeError(_state["load_error"] or "corpus chưa nạp")
    if not re.fullmatch(r"[a-z0-9-]+", tag_id or ""):
        raise ValueError("tag id chỉ gồm a-z, 0-9, dấu gạch nối")
    if tag_id in valid_tag_ids():
        raise ValueError(f"Tag {tag_id} đã tồn tại")

    def mutate(tags: list) -> None:
        tags.append({"id": tag_id, "hashtag": f"#{tag_id}",
                     "description": description,
                     "synonyms": synonyms or [],
                     "examples": examples or [],
                     "source": "admin", "page_range": None, "parent": None})

    _write_tags_doc(mutate)
    r = reload_corpus()
    if not r["loaded"]:
        raise RuntimeError(r["error"])
    return {"tag": tag_id, "added": True}


def admin_delete_tag(tag_id: str) -> dict:
    """Xoá tag: gỡ khỏi tags.json + mọi tag tay của chunk."""
    if not ensure_loaded():
        raise RuntimeError(_state["load_error"] or "corpus chưa nạp")
    if tag_id not in valid_tag_ids():
        raise ValueError(f"Không có tag {tag_id}")

    def mutate(tags: list) -> None:
        tags[:] = [t for t in tags if t["id"] != tag_id]

    _write_tags_doc(mutate)
    manual = _load_manual()
    touched = [cid for cid, tl in manual.items() if tag_id in tl]
    for cid in touched:
        manual[cid] = [t for t in manual[cid] if t != tag_id]
    if touched:
        _save_manual(manual)
    _drop_tag_caches(tag_id)
    r = reload_corpus()
    if not r["loaded"]:
        raise RuntimeError(r["error"])
    return {"tag": tag_id, "deleted": True, "removed_from_chunks": touched}
