#!/usr/bin/env python3
"""
demo_ollama.py — Demo RAG N-tag (23 tag) chạy trên Ollama (offline, localhost:11434)

Models:
  - Trả lời  : qwen2.5:3b-instruct      (--model để đổi)
  - Embedding : batiai/qwen3-embedding:0.6b-q8

Luồng (đúng thiết kế đã chốt):
  [1] embed câu hỏi
  [2] chấm điểm mềm N tag  (cosine vs mô tả + synonyms, cache lại)
  [3] quyết định theo điểm + margin  (trả lời ngay / hỏi lại / ngoài tài liệu)
  [4] hybrid search BM25 + vector    (scoped top-1 tag + global fallback, gộp RRF)
  [5] build prompt (kèm tag + trang) → [6] LLM trả lời, bắt buộc trích nguồn

Usage:
  .venv/bin/python demo_ollama.py "Điều kiện xét học bổng là gì?"
  .venv/bin/python demo_ollama.py --preheat "... "     # nạp model ngay lúc mở (không cold start)
  .venv/bin/python demo_ollama.py                    # interactive (gõ câu hỏi, rỗng = thoát)
  .venv/bin/python demo_ollama.py --no-llm "..."     # chỉ xem tag + chunk + prompt
  .venv/bin/python demo_ollama.py --keep-alive -1 "..."   # giữ model RAM mãi (mặc định 24h)
  .venv/bin/python demo_ollama.py --prompt-file p.txt "..."
  .venv/bin/python demo_ollama.py --golden --limit 5 --out results.md

Cold start: lần gọi ĐẦU model chưa ở RAM = +55-88s nạp từ disk.
keep_alive (mặc định 24h) giữ model sau call → các câu sau KHÔNG mất phí này.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import httpx
import numpy as np
from rank_bm25 import BM25Okapi

# ============================================================
# CẤU HÌNH
# ============================================================
OLLAMA = "http://localhost:11434"
CHAT_MODEL = "qwen2.5:3b-instruct"
EMBED_MODEL = "batiai/qwen3-embedding:0.6b-q8"

BASE = Path(__file__).resolve().parent
CORPUS = BASE / "data" / "corpus"
CHUNKS_FILE = CORPUS / "chunks_tagged.jsonl"
TAGS_FILE = CORPUS / "tags.json"
GOLDEN_FILE = CORPUS / "golden_qa.json"
CACHE_DIR = CORPUS / "cache"

TOPK = 1              # số chunk đưa vào context
MARGIN_ASK = 0.08     # margin top1-top2 dưới mức này → câu hỏi mơ hồ (hỏi lại)
SCORE_LOW = 0.30      # top1 dưới mức này → nghi ngờ ngoài tài liệu

KEEP_ALIVE = "24h"    # giữ model trong RAM → không cold start ở câu sau
                      # ("-1" = mãi mãi, "5m" = mặc định của Ollama)

MAX_TOKENS = 280      # chặn số token sinh tối đa (trên CPU 2 nhân: ~6 tok/s
                      # → 160 tok ≈ 27s trần; câu trả lời bình thường 45-150 tok)

_LAST_STATS: dict = {}   # timing của call LLM gần nhất (tự cập nhật trong chat())

# ------------------------------------------------------------
# PROMPT — sửa thoải mái, hoặc tách ra file rồi --prompt-file
# ------------------------------------------------------------
SYSTEM_PROMPT = """Bạn là trợ lý chính thức của Trường Đại học Giao thông vận tải (UTC),\
 trả lời câu hỏi của sinh viên dựa trên TÀI LIỆU ĐƯỢC CUNG CẤP DƯỚI ĐÂY.

BẮT BUỘC:
bạn trả lời ngắn gọn."""

USER_TEMPLATE = """## TÀI LIỆU
{context}

## CÂU HỎI CỦA SINH VIÊN
{question}

## TRẢ LỜI
(trích nguồn [T1], [T2]... sau mỗi khẳng định)"""


# ============================================================
# OLLAMA CLIENT
# ============================================================
def embed(texts: list[str]) -> np.ndarray:
    """Embed danh sách text → matrix (n, d), L2-normalized."""
    all_vecs = []
    batch = 8                              # CPU-only: batch nhỏ cho ổn định
    for i in range(0, len(texts), batch):
        chunk = texts[i:i + batch]
        for attempt in range(3):           # retry 3 lần
            try:
                r = httpx.post(f"{OLLAMA}/api/embed",
                               json={"model": EMBED_MODEL, "input": chunk,
                                     "keep_alive": KEEP_ALIVE},
                               timeout=300)
                r.raise_for_status()
                all_vecs.extend(r.json()["embeddings"])
                break
            except httpx.HTTPError as e:
                if attempt == 2:
                    raise
                print(f"  [embed retry {attempt+1}] {e}", file=sys.stderr)
                time.sleep(2)
        print(f"\r  embedded {min(i + batch, len(texts))}/{len(texts)}",
              end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    m = np.asarray(all_vecs, dtype=np.float32)
    return m / np.linalg.norm(m, axis=1, keepdims=True)


def chat(messages: list[dict], stream: bool = True,
         temperature: float = 0.2, num_predict: int | None = None):
    """Gọi /api/chat. stream=True → generator sinh text; False → string.

    keep_alive: giữ model trong RAM sau mỗi call (mặc định "24h")
    → lần gọi đầu nạp model 1 lần, các lần sau không mất 55-88s cold start.
    temperature/num_predict: chỉnh được từ webapp (mặc định = CLI).
    """
    payload = {"model": CHAT_MODEL, "messages": messages,
               "stream": stream,
               "options": {"temperature": temperature,
                           "num_predict": num_predict or MAX_TOKENS},
               "keep_alive": KEEP_ALIVE}
    if not stream:
        r = httpx.post(f"{OLLAMA}/api/chat", json=payload, timeout=300)
        r.raise_for_status()
        data = r.json()
        _LAST_STATS.update(_stats_of(data))
        return data["message"]["content"]

    def gen():
        with httpx.stream("POST", f"{OLLAMA}/api/chat", json=payload,
                          timeout=300) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line:
                    continue
                data = json.loads(line)
                if data.get("done"):
                    _LAST_STATS.update(_stats_of(data))   # stats ở chunk cuối
                else:
                    yield data["message"]["content"]
    return gen()


def _stats_of(data: dict) -> dict:
    """Trích timing từ response Ollama (đơn vị: ns)."""
    return {
        "load_ms": data.get("load_duration", 0) / 1e6,
        "prompt_tokens": data.get("prompt_eval_count", 0),
        "prompt_cached": data.get("prompt_eval_cached_count", 0),
        "prompt_ms": data.get("prompt_eval_duration", 0) / 1e6,
        "out_tokens": data.get("eval_count", 0),
        "gen_ms": data.get("eval_duration", 0) / 1e6,
    }


def preheat():
    """Nạp model vào RAM NGAY TỪ ĐẦU (trước khi user gõ câu hỏi)."""
    t0 = time.time()
    print(f"Preheat: nạp {CHAT_MODEL} (keep_alive={KEEP_ALIVE}) ...",
          file=sys.stderr, end="", flush=True)
    chat([{"role": "user", "content": "oke"}], stream=False)
    print(f" OK ({time.time()-t0:.1f}s)", file=sys.stderr)


# ============================================================
# CACHE
# ============================================================
def _cache_path(name: str) -> Path:
    safe = EMBED_MODEL.replace("/", "_").replace(":", "_")
    return CACHE_DIR / f"{name}_{safe}.json"


def load_cache(name: str) -> dict:
    p = _cache_path(name)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {}


def save_cache(name: str, data: dict):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(name).write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8")


# ============================================================
# TẢI DỮ LIỆU
# ============================================================
def load_all():
    chunks = [json.loads(l) for l in CHUNKS_FILE.read_text(
        encoding="utf-8").splitlines() if l.strip()]
    tags = json.loads(TAGS_FILE.read_text(encoding="utf-8"))["tags"]

    # --- embed tag (description + synonyms) — cache ---
    tag_cache = load_cache("tag_embeds")
    missing = [t for t in tags if t["id"] not in tag_cache]
    if missing:
        print(f"  embed {len(missing)} tag ...", file=sys.stderr)
        texts = [t["description"] + " " + " ".join(t["synonyms"]) for t in missing]
        vecs = embed(texts)
        for t, v in zip(missing, vecs):
            tag_cache[t["id"]] = v.tolist()
        save_cache("tag_embeds", tag_cache)

    # --- embed chunk — cache (lưu sau mỗi wave 32 để không mất công nếu crash) ---
    ch_cache = load_cache("chunk_embeds")
    missing = [c for c in chunks if c["id"] not in ch_cache]
    if missing:
        print(f"  embed {len(missing)} chunk ...", file=sys.stderr)
        for i in range(0, len(missing), 32):
            wave = missing[i:i + 32]
            vecs = embed([c["text"] for c in wave])
            for c, v in zip(wave, vecs):
                ch_cache[c["id"]] = v.tolist()
            save_cache("chunk_embeds", ch_cache)   # checkpoint mỗi wave

    tag_mat = np.asarray([tag_cache[t["id"]] for t in tags], dtype=np.float32)
    ch_mat = np.asarray([ch_cache[c["id"]] for c in chunks], dtype=np.float32)

    # --- BM25 ---
    tokenized = [re.findall(r"\w+", c["text"].lower()) for c in chunks]
    bm25 = BM25Okapi(tokenized)

    return chunks, tags, tag_mat, ch_mat, bm25


# ============================================================
# [2] CHẤM ĐIỂM TAG
# ============================================================
def score_tags(question: str, q_vec: np.ndarray, tags, tag_mat) -> list:
    sims = tag_mat @ q_vec
    order = np.argsort(-sims)
    return [(tags[i]["id"], float(sims[i])) for i in order]


# ============================================================
# [3] QUYẾT ĐỊNH & HASHTAG EXTRACTOR
# ============================================================
def extract_hashtag(text: str, tags) -> tuple[str, str | None]:
    """Tìm #hashtag trong text, đối chiếu với danh sách tags.
    Hỗ trợ cả tag viết bằng '_' thay cho '-' và từ viết tắt trong synonyms (như #ktx).
    Trả về (clean_text, tag_id). Nếu không tìm thấy: (text, None)."""
    tags_map: dict[str, str] = {}
    all_ids: list[str] = []

    if isinstance(tags, (set, list)):
        for item in tags:
            if isinstance(item, dict):
                tid = item["id"].lower()
                tags_map[tid] = tid
                tags_map[tid.replace("-", "_")] = tid
                all_ids.append(tid)
                for s in (item.get("synonyms") or []):
                    s_clean = s.strip().lower().replace(" ", "-").replace("_", "-")
                    if s_clean and s_clean not in tags_map:
                        tags_map[s_clean] = tid
                    s_raw = s.strip().lower()
                    if s_raw and s_raw not in tags_map:
                        tags_map[s_raw] = tid
            elif isinstance(item, str):
                tid = item.lower()
                tags_map[tid] = tid
                tags_map[tid.replace("-", "_")] = tid
                all_ids.append(tid)

    found_tag = None
    for m in re.finditer(r"#([a-zA-Z0-9_\-]+)", text):
        raw = m.group(1).lower()
        if raw in tags_map:
            found_tag = tags_map[raw]
            break
        norm = raw.replace("_", "-")
        if norm in tags_map:
            found_tag = tags_map[norm]
            break

    # Nếu chưa match chính xác, thử tìm prefix duy nhất (vd: #don-vi -> don-vi-cong-tac-sinh-vien)
    if not found_tag:
        for m in re.finditer(r"#([a-zA-Z0-9_\-]+)", text):
            raw = m.group(1).lower().replace("_", "-")
            cands = [tid for tid in all_ids if tid.startswith(raw) or raw in tid]
            if len(cands) == 1:
                found_tag = cands[0]
                break

    if found_tag:
        clean_text = re.sub(r"#([a-zA-Z0-9_\-]+)", "", text).strip()
        clean_text = re.sub(r"\s+", " ", clean_text)
        return (clean_text or text, found_tag)
    return (text, None)


def decide(scores: list) -> tuple[str, str]:
    top_id, top = scores[0]
    margin = top - scores[1][1]
    if top < SCORE_LOW:
        return ("OUT_OF_SCOPE",
                f"top1={top:.3f} < {SCORE_LOW} → nghi câu hỏi ngoài tài liệu")
    if margin < MARGIN_ASK:
        rivals = ", ".join(f"#{i}={s:.3f}" for i, s in scores[:3])
        return ("ASK_BACK",
                f"margin={margin:.3f} < {MARGIN_ASK} → mơ hồ, nên hỏi lại ({rivals})")
    return ("ANSWER", f"top1={top:.3f}, margin={margin:.3f} → trả lời theo #{top_id}")


# ============================================================
# [4] HYBRID SEARCH — BM25 + vector, gộp RRF (scoped + global)
# ============================================================
def retrieve(question: str, q_vec: np.ndarray, top_tag: str,
             chunks, ch_mat, bm25, k: int = TOPK,
             rrf_k: int = 60, tag_boost: float = 1.5):
    """Hybrid BM25+vector gộp RRF. rrf_k/tag_boost chỉnh được từ webapp."""
    bm25_scores = bm25.get_scores(re.findall(r"\w+", question.lower()))
    rank_bm25 = np.argsort(np.argsort(-bm25_scores))          # rank 0 = tốt nhất
    rank_vec = np.argsort(np.argsort(-(ch_mat @ q_vec)))
    scoped = np.array([top_tag in (c["tags"] or []) for c in chunks])

    rrf = 1 / (rrf_k + rank_bm25) + 1 / (rrf_k + rank_vec)
    rrf[scoped] += 1 / (rrf_k + rank_vec[scoped]) * tag_boost  # boost tag top-1

    top_idx = np.argsort(-rrf)[:k]
    global_top = np.argsort(-(1 / (rrf_k + rank_bm25)
                                + 1 / (rrf_k + rank_vec)))[:k]
    return [(int(i), float(rrf[i])) for i in top_idx], list(map(int, global_top))


# ============================================================
# [5] BUILD PROMPT
# ============================================================
def build_context(hits, chunks) -> tuple[str, list]:
    used = []
    parts = []
    for rank, (idx, score) in enumerate(hits, 1):
        c = chunks[idx]
        used.append(c)
        tags = ", ".join(f"#{t}" for t in c["tags"]) or "(không tag)"
        parts.append(
            f"[T{rank}] {c['id']} | trang {c['page_start']}"
            + (f"-{c['page_end']}" if c["page_end"] != c["page_start"] else "") \
            + f" | {tags}\n{c['text']}"
        )
    return "\n\n---\n\n".join(parts), used


def build_messages(context: str, question: str, user_tmpl: str) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_tmpl.format(
            context=context, question=question)},
    ]


# ============================================================
# CHẠY 1 CÂU HỎI
# ============================================================
def run(question: str, args, chunks, tags, tag_mat, ch_mat, bm25,
        user_tmpl: str, log: list | None = None):
    t0 = time.time()
    bar = "=" * 18
    print(f"\n{bar} CÂU HỎI {bar}\n{question}")

    # [0] nhận diện hashtag trong câu hỏi nếu có
    clean_q, forced_tag = extract_hashtag(question, tags)
    search_q = clean_q if forced_tag else question

    # [1] embed
    q_vec = embed([search_q])[0]

    # [2] score tags
    scores = score_tags(search_q, q_vec, tags, tag_mat)
    print(f"\n{bar} [2] ĐIỂM {len(tags)} TAG (top 5) {bar}")
    for tid, s in scores[:5]:
        bar_len = int(s * 40)
        print(f"  #{tid:<26} {s:.3f} {'█' * bar_len}")

    # [3] quyết định
    if forced_tag:
        top_tag = forced_tag
        auto_top, auto_score = scores[0]
        decision = "ANSWER"
        why = f"nhận diện hashtag #{forced_tag} trong câu hỏi (điểm tự động: #{auto_top}={auto_score:.3f})"
    else:
        decision, why = decide(scores)
        top_tag = scores[0][0]

    print(f"\n{bar} [3] QUYẾT ĐỊNH: {decision} {bar}\n  {why}")
    if decision == "ASK_BACK":
        top3 = " / ".join(f"#{t}" for t, _ in scores[:3])
        print(f"  → GỢI Ý HỎI LẠI: \"{question}\" thuộc {top3}?\n"
              f"    (demo vẫn trả lời để bạn test prompt)")

    # [4] retrieve
    if forced_tag:
        scoped = [i for i, c in enumerate(chunks) if forced_tag in (c.get("tags") or [])]
        if scoped:
            bm25_scores = bm25.get_scores(re.findall(r"\w+", search_q.lower()))
            rank_bm25 = np.argsort(np.argsort(-bm25_scores))
            rank_vec = np.argsort(np.argsort(-(ch_mat @ q_vec)))
            rrf_k = 60
            rrf = 1 / (rrf_k + rank_bm25) + 1 / (rrf_k + rank_vec)
            scoped.sort(key=lambda i: -rrf[i])
            hits = [(int(i), float(rrf[i])) for i in scoped[:TOPK]]
            global_top = np.argsort(-rrf)[:TOPK]
        else:
            hits, global_top = retrieve(search_q, q_vec, top_tag, chunks, ch_mat, bm25, k=TOPK)
    else:
        hits, global_top = retrieve(search_q, q_vec, top_tag, chunks, ch_mat, bm25, k=TOPK)

    print(f"\n{bar} [4] CHUNK TRUYỀN (RRF hybrid, scoped=#{top_tag}) {bar}")
    for i, (idx, sc) in enumerate(hits, 1):
        c = chunks[idx]
        pages = f"p.{c['page_start']}" + (
            f"-{c['page_end']}" if c["page_end"] != c["page_start"] else "")
        print(f"  T{i} {c['id']} {pages} rrf={sc:.4f} "
              f"{'[' + ','.join(c['tags']) + ']' if c['tags'] else '[no-tag]'}")
        print(f"     {c['text'][:110].replace(chr(10), ' ')}...")
    g_miss = [i for i in global_top if i not in {h[0] for h in hits}]
    if g_miss:
        print(f"  (global fallback có {len(g_miss)} chunk khác không lọt top)")

    # [5] prompt
    context, used = build_context(hits, chunks)
    messages = build_messages(context, search_q, user_tmpl)
    print(f"\n{bar} [5] PROMPT {bar}")
    print("--- SYSTEM ---")
    print(messages[0]["content"])
    print("--- USER ---")
    print(messages[1]["content"])

    if args.no_llm:
        print(f"\n[--no-llm] Dừng ở đây. ({time.time()-t0:.1f}s)")
        if log is not None:
            log.append({"question": question, "decision": decision,
                        "why": why, "tags": scores[:3],
                        "answer": None, "prompt": messages[1]["content"]})
        return

    # [6] LLM
    print(f"\n{bar} [6] TRẢ LỜI ({CHAT_MODEL}) {bar}")
    parts = []
    try:
        for piece in chat(messages):
            print(piece, end="", flush=True)
            parts.append(piece)
        print()
    except httpx.HTTPError as e:
        print(f"\n[LLM ERROR] {e}")
        parts = [f"[LLM ERROR] {e}"]
    answer = "".join(parts)
    s = _LAST_STATS
    truncated = bool(s) and s.get("out_tokens", 0) >= MAX_TOKENS
    print(f"\n  ⏱  tổng {time.time()-t0:.1f}s"
          + (f"  |  nạp model {s['load_ms']:.0f}ms"
             + (f" ← cold start!" if s.get("load_ms", 0) > 2000 else " (warm ✓)")
             + f"  |  đọc prompt {s['prompt_ms']:.0f}ms"
             + f" ({s['prompt_tokens']} tok, cache {s['prompt_cached']})"
             + f"  |  sinh {s['gen_ms']:.0f}ms ({s['out_tokens']} tok)"
             if s else ""))
    if truncated:
        print(f"  ⚠  chạm trần {MAX_TOKENS} token — câu trả lời CÓ THỂ bị cắt. "
              f"Tăng --max-tokens nếu thiếu.")

    print(f"\n{bar} NGUỒN ĐÃ DÙNG {bar}")
    for i, c in enumerate(used, 1):
        print(f"  [T{i}] {c['id']} tr.{c['page_start']}-{c['page_end']} "
              f"{'#'+c['tag_primary'] if c['tag_primary'] else ''} | "
              f"{(c['heading'].get('dieu') or c['heading'].get('muc') or '')[:60]}")

    if log is not None:
        log.append({"question": question, "decision": decision, "why": why,
                    "tags": scores[:3], "answer": answer,
                    "sources": [c["id"] for c in used],
                    "prompt": messages[1]["content"]})


# ============================================================
# GOLDEN QA — chạy batch để test prompt
# ============================================================
def run_golden(args, *loaders):
    try:
        from gan_tag import GOLDEN_EXPECTED_TAG
    except ImportError:
        GOLDEN_EXPECTED_TAG = {}
    qs = json.loads(GOLDEN_FILE.read_text(encoding="utf-8"))
    if args.limit:
        qs = qs[:args.limit]
    log = []
    print(f"\n{'#'*60}\n# GOLDEN QA — {len(qs)} câu\n{'#'*60}")
    for q in qs:
        expect = GOLDEN_EXPECTED_TAG.get(q["id"], "?")
        print(f"\n{'─'*60}\n▶ {q['id']} (tag kỳ vọng: #{expect})")
        run(q["question"], args, *loaders, user_tmpl=args._tmpl, log=log)
    if args.out:
        lines = ["# Golden QA results", ""]
        for e in log:
            lines += [f"## {e['question']}", "",
                      f"- decision: `{e['decision']}` — {e['why']}",
                      f"- top tags: {e['tags']}", ""]
            if e["answer"]:
                lines += ["```", e["answer"], "```", ""]
            else:
                lines += ["_(no-llm)_", ""]
        Path(args.out).write_text("\n".join(lines), encoding="utf-8")
        print(f"\nĐã ghi {args.out}")


# ============================================================
# MAIN
# ============================================================
def main():
    global CHAT_MODEL, TOPK, KEEP_ALIVE, MAX_TOKENS
    ap = argparse.ArgumentParser(description="Demo RAG N-tag với Ollama")
    ap.add_argument("question", nargs="?", help="câu hỏi (bỏ trống = interactive)")
    ap.add_argument("--model", default=CHAT_MODEL, help="ollama chat model")
    ap.add_argument("--prompt-file", help="file chứa USER_TEMPLATE "
                                          "(dùng {context} và {question})")
    ap.add_argument("--no-llm", action="store_true", help="chỉ xem tag/chunk/prompt")
    ap.add_argument("--golden", action="store_true", help="chạy golden_qa.json")
    ap.add_argument("--limit", type=int, help="giới hạn số câu golden")
    ap.add_argument("--out", help="ghi kết quả golden ra file markdown")
    ap.add_argument("--topk", type=int, default=TOPK)
    ap.add_argument("--max-tokens", type=int, default=MAX_TOKENS,
                    help="số token sinh tối đa (mặc định %(default)s)")
    ap.add_argument("--keep-alive", default=KEEP_ALIVE, metavar="DUR",
                    help='giữ model trong RAM: "24h", "-1" (mãi), "5m" '
                         '(mặc định Ollama) — mặc định %(default)s')
    ap.add_argument("--preheat", action="store_true",
                    help="nạp model NGAY khi mở script (chuyển 55-88s cold start "
                         "về lúc khởi động, các câu sau 0s load)")
    args = ap.parse_args()

    CHAT_MODEL = args.model
    TOPK = args.topk
    KEEP_ALIVE = args.keep_alive
    MAX_TOKENS = args.max_tokens

    if args.preheat and not args.no_llm:
        preheat()

    user_tmpl = USER_TEMPLATE
    if args.prompt_file:
        user_tmpl = Path(args.prompt_file).read_text(encoding="utf-8")
    args._tmpl = user_tmpl

    print(f"Đọc corpus ...", file=sys.stderr)
    loaders = load_all()
    chunks, tags = loaders[0], loaders[1]

    if args.golden:
        run_golden(args, *loaders)
    elif args.question:
        run(args.question, args, *loaders, user_tmpl=user_tmpl)
    else:
        print("Interactive — gõ câu hỏi, Enter rỗng để thoát.")
        while True:
            try:
                q = input("\ncâu hỏi> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not q:
                break
            run(q, args, *loaders, user_tmpl=user_tmpl)


if __name__ == "__main__":
    main()
