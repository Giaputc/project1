"""
rebuild.py — Đồng bộ data/so_tay_sinh_vien_k64.md → corpus RAG → web.

Sửa thông tin trong file .md rồi chạy:
    .venv/bin/python rebuild.py            # rebuild + verify + reload backend
    .venv/bin/python rebuild.py --dry-run  # chỉ in diff, KHÔNG ghi gì
    .venv/bin/python rebuild.py --no-reload  # bỏ qua bước gọi backend reload

Luồng:
  [1] So md (đã normalize) với text 158 chunk cũ (substring match từng chunk).
      - Chunk text còn y trong md  → SẠCH, giữ nguyên (id, trang, vector).
      - Chunk text không còn       → ĐỔI (user đã sửa).
  [2] Vùng ĐỔI: cắt lại theo heading + đoạn văn (≤1200 ký tự),
      KẾ THỪA id + số trang từ chunk cũ theo thứ tự.
  [3] Ghi chunks.jsonl (backup trước) → chạy gan_tag.py (verify 23 tag +
      golden_qa). FAIL → ROLLBACK, không cập nhật gì.
  [4] Embed lại CHỈ các chunk đổi (xóa vector cũ khỏi cache).
  [5] Gọi backend POST /api/corpus/reload → web trả lời dữ liệu mới NGAY.

KHÔNG sửa demo_ollama.py / gan_tag.py — chỉ import và điều phối.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
import unicodedata
from pathlib import Path

BASE = Path(__file__).resolve().parent
MD_FILE = BASE / "data" / "so_tay_sinh_vien_k64.md"
CORPUS = BASE / "data" / "corpus"
CHUNKS_FILE = CORPUS / "chunks.jsonl"
CACHE_DIR = CORPUS / "cache"
BACKEND = "http://localhost:8000"

MAX_SIZE = 1200          # bằng max chunk hiện có (max thực tế trong corpus: 1199)
IMG_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
HEAD_RE = re.compile(r"^(#{1,4})\s+(.+?)\s*$", re.M)

sys.path.insert(0, str(BASE))
import demo_ollama as de  # noqa: E402
import gan_tag            # noqa: E402


# ================================================================
# [1] NORMALIZE + INDEX MAP  (md → chuỗi tìm kiếm + map về vị trí gốc)
# ================================================================
def build_norm_index(text: str) -> tuple[str, list[int]]:
    """Xây chuỗi chuẩn hóa (bỏ ảnh, NFC từng ký tự, gộp khoảng trắng)
    kèm idx_map: vị trí trong norm → vị trí trong text GỐC."""
    out: list[str] = []
    idx: list[int] = []
    i, n = 0, len(text)
    prev_space = False
    while i < n:
        ch = text[i]
        # bỏ nguyên span ảnh ![...](...)
        if ch == "!" and text.startswith("![", i):
            m = IMG_RE.match(text, i)
            if m:
                i = m.end()
                continue
        if ch.isspace():
            if not prev_space and out:
                out.append(" ")
                idx.append(i)
            prev_space = True
            i += 1
            continue
        prev_space = False
        for nc in unicodedata.normalize("NFC", ch):   # có thể ra >1 ký tự
            out.append(nc)
            idx.append(i)
        i += 1
    return "".join(out), idx


def norm_one(s: str) -> str:
    """Chuẩn hóa 1 chuỗi (chunk text) theo đúng cùng routine."""
    return build_norm_index(s)[0]


# ================================================================
# [2] TÌM CHUNK SẠCH / VÙNG ĐỔI
# ================================================================
def locate_chunks(chunks: list, nmd: str) -> tuple[list[int | None], list[tuple[int, int]]]:
    """Trả về (matches, regions):
       matches[i]  = vị trí start trong norm-space của chunk i (None = ĐỔI)
       regions     = list (start, end) norm-space của từng run chunk ĐỔI
    """
    cursor = 0
    matches: list[int | None] = []
    prev_start = -1
    for c in chunks:
        t = norm_one(c["text"])
        pos = nmd.find(t, cursor)                 # tìm tiếp từ vị trí cũ (thứ tự md)
        if pos == -1 and cursor > 0:
            pos = nmd.find(t)                     # fallback: tìm toàn bộ
        # corpus cũ CHỒNG LẤN nhau (~100-150 ký tự) → chỉ yêu cầu tiến
        # so với chunk start trước đó, không yêu cầu không đè lên nhau
        if pos == -1 or pos <= prev_start:
            matches.append(None)
        else:
            matches.append(pos)
            cursor = pos + 1
            prev_start = pos

    regions = []
    i, n = 0, len(chunks)
    lead_anchor = nmd.find("# LỜI NÓI ĐẦU")
    if lead_anchor == -1:
        lead_anchor = 0
    while i < n:
        if matches[i] is not None:
            i += 1
            continue
        j = i
        while j < n and matches[j] is None:
            j += 1
        start = matches[i - 1] + len(norm_one(chunks[i - 1]["text"])) if i > 0 \
            else lead_anchor
        end = matches[j] if j < n else len(nmd)
        if end < start:                            # phòng lệch thứ tự
            end = len(nmd)
        regions.append((start, end))
        i = j
    return matches, regions


# ================================================================
# [3] CẮT VÙNG ĐỔI → CHUNK MỚI (heading + đoạn văn)
# ================================================================
def heading_dict(phan: str, muc: str, chuong: str, dieu: str) -> dict:
    return {"phan": phan, "muc": muc, "chuong": chuong, "dieu": dieu}


def split_paragraphs(text: str, max_size: int = MAX_SIZE) -> list[str]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    pieces: list[str] = []
    buf = ""
    for p in paras:
        if len(p) > max_size:                      # đoạn quá dài → cắt cứng
            if buf:
                pieces.append(buf)
                buf = ""
            while len(p) > max_size:
                pieces.append(p[:max_size])
                p = p[max_size:]
            buf = p
        elif not buf:
            buf = p
        elif len(buf) + 2 + len(p) <= max_size:
            buf += "\n\n" + p
        else:
            pieces.append(buf)
            buf = p
    if buf:
        pieces.append(buf)
    return pieces


def parse_region(region_text: str, init_heading: dict) -> list[tuple[str, dict]]:
    """Cắt 1 vùng md thành các piece (text, heading).
    - Heading dòng bị LOẠI khỏi text (corpus hiện tại không chứa heading trong text).
    - Heading state khởi tạo từ chunk đứng trước vùng; heading trong vùng cập nhật
      (reset level sâu hơn khi gặp level cao hơn).
    - Text bỏ ảnh markdown, cắt theo đoạn ≤ MAX_SIZE ký tự."""
    state = dict(init_heading)
    out: list[tuple[str, dict]] = []
    parts = HEAD_RE.split(region_text)   # [pre, lvl, title, body, lvl, title, body, ...]
    if parts[0].strip():
        out.append((parts[0], dict(state)))
    for k in range(1, len(parts), 3):
        level = len(parts[k])
        title = parts[k + 1].strip()
        body = parts[k + 2]
        if level == 1:
            state = {"phan": title, "muc": "", "chuong": "", "dieu": ""}
        elif level == 2:
            state = {**state, "muc": title, "chuong": "", "dieu": ""}
        elif level == 3:
            state = {**state, "chuong": title, "dieu": ""}
        else:
            state = {**state, "dieu": title}
        if body.strip():
            out.append((body, dict(state)))

    pieces: list[tuple[str, dict]] = []
    for body, h in out:
        txt = IMG_RE.sub("", body).strip()
        for pc in split_paragraphs(txt):
            if pc:
                pieces.append((pc, h))
    return pieces


def make_title(h: dict) -> str:
    return " › ".join(x for x in (h["phan"], h["muc"], h["chuong"], h.get("dieu") or "") if x)


# ================================================================
# MAIN
# ================================================================
def main() -> int:
    ap = argparse.ArgumentParser(description="Đồng bộ .md → corpus RAG")
    ap.add_argument("--dry-run", action="store_true", help="chỉ in diff, không ghi")
    ap.add_argument("--no-reload", action="store_true", help="bỏ qua gọi backend reload")
    args = ap.parse_args()

    # ---------- Load ----------
    chunks = [json.loads(l) for l in CHUNKS_FILE.read_text(encoding="utf-8").splitlines() if l.strip()]
    md = MD_FILE.read_text(encoding="utf-8")
    nmd, idx_map = build_norm_index(md)
    print(f"[1] Đọc {len(chunks)} chunk cũ + md ({len(md)} ký tự)")

    matches, regions = locate_chunks(chunks, nmd)
    dirty_idx = [i for i, m in enumerate(matches) if m is None]
    print(f"    Sạch: {len(chunks) - len(dirty_idx)} chunk giữ nguyên | "
          f"ĐỔI: {len(dirty_idx)} chunk")
    if not dirty_idx:
        print("[OK] Không có gì thay đổi — corpus đã khớp md. Thoát.")
        return 0

    # ---------- Build chunk mới từ vùng đổi ----------
    dirty_ids = [chunks[i]["id"] for i in dirty_idx]
    print(f"    Các chunk đổi: {', '.join(dirty_ids)}")

    used_ids = {c["id"] for c in chunks}
    m_ns = re.match(r"^(.*?)(\d+)$", chunks[-1]["id"])
    id_prefix, next_num = m_ns.group(1), int(m_ns.group(2)) + 1

    def alloc_id() -> str:
        nonlocal next_num
        while f"{id_prefix}{next_num:04d}" in used_ids:
            next_num += 1
        nid = f"{id_prefix}{next_num:04d}"
        used_ids.add(nid)
        next_num += 1
        return nid

    new_chunks: list[dict] = []
    report: list[str] = []
    ri = 0                      # chỉ số run trong regions
    for i, c in enumerate(chunks):
        if matches[i] is not None:
            new_chunks.append(c)
            continue

        # --- vùng đổi chứa chunk[i] ---
        start, end = regions[ri]
        ri += 1
        # run = các chunk ĐỔI liên tiếp từ i (end đã là điểm bắt đầu chunk
        # sạch j hoặc hết doc; start là điểm kết thúc chunk sạch i-1 hoặc anchor đầu)
        j = i
        while j < len(chunks) and matches[j] is None:
            j += 1
        run = chunks[i:j]

        orig_start = idx_map[start]
        orig_end = idx_map[end - 1] + 1 if end - 1 < len(idx_map) else len(md)
        region_text = md[orig_start:orig_end]

        # heading khởi tạo: chunk đứng trước run (nếu không phải đầu doc)
        init_h = chunks[i - 1]["heading"] if i > 0 else run[0]["heading"]
        pieces = parse_region(region_text, init_h)

        # --- ghép piece ↔ chunk cũ (kế thừa id + trang) ---
        for k, (ptext, ph) in enumerate(pieces):
            if k < len(run):
                src = run[k]
                nc = dict(src)
                nc["text"] = ptext
                nc["char_count"] = len(ptext)
                nc["heading"] = dict(ph)
                new_chunks.append(nc)
            else:                                  # piece thừa → id mới
                page_ref = run[-1]
                nc = {
                    "id": alloc_id(),
                    "doc_id": run[0].get("doc_id"),
                    "source": run[0].get("source"),
                    "text": ptext,
                    "title": make_title(ph),
                    "section": ph["chuong"] or ph["muc"] or ph["phan"],
                    "heading": dict(ph),
                    "page_start": page_ref["page_end"],
                    "page_end": page_ref["page_end"],
                    "page_conf": page_ref.get("page_conf"),
                    "images": [],
                    "char_count": len(ptext),
                }
                new_chunks.append(nc)
                report.append(f"  + chunk mới {nc['id']} (trang kế thừa ~{nc['page_start']})")
        if len(pieces) < len(run):
            for c in run[len(pieces):]:
                report.append(f"  - chunk {c['id']} bị LOẠI (md không còn nội dung riêng)")

    # ---------- In diff / thống kê ----------
    print("\n[2] KẾT QUẢ BUILD:")
    old_ids = {c["id"] for c in chunks}
    new_ids = {c["id"] for c in new_chunks}
    for line in report:
        print(line)
    print(f"    Tổng: {len(chunks)} → {len(new_chunks)} chunk "
          f"(mới: {sorted(new_ids - old_ids) or 'không'}, "
          f"xóa: {sorted(old_ids - new_ids) or 'không'})")
    print(f"    Text đổi (sẽ embed lại): {', '.join(dirty_ids)}")

    if args.dry_run:
        print("\n[--dry-run] Không ghi file nào. Thoát.")
        return 0

    # ---------- Ghi + verify tag (gan_tag) ----------
    backup = CHUNKS_FILE.with_suffix(f".jsonl.bak.{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(CHUNKS_FILE, backup)
    print(f"\n[3] Backup: {backup.name}")
    with open(CHUNKS_FILE, "w", encoding="utf-8") as f:
        for c in new_chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    print("    Chạy gan_tag.py verify ...")
    rc = gan_tag.main()
    if rc != 0:
        shutil.copy2(backup, CHUNKS_FILE)
        print(f"[FAIL] Verify tag/golden FAIL → RESTORE {backup.name}. "
              f"Sửa heading/RULES trong gan_tag.py rồi chạy lại.")
        return 1

    # ---------- Embed lại chunk đổi ----------
    changed_ids = [c["id"] for c in new_chunks if c["id"] in set(dirty_ids)]
    added = sorted(new_ids - old_ids)
    changed_ids += added
    cache_file = de._cache_path("chunk_embeds")
    cache = json.loads(cache_file.read_text(encoding="utf-8")) if cache_file.exists() else {}
    to_embed = [c for c in new_chunks if c["id"] in set(changed_ids)]
    print(f"\n[4] Embed lại {len(to_embed)} chunk đổi ...")
    if to_embed:
        vecs = de.embed([c["text"] for c in to_embed])
        for c, v in zip(to_embed, vecs):
            cache[c["id"]] = v.tolist()
        de.save_cache("chunk_embeds", cache)
        print("    Đã cập nhật cache embed.")
    else:
        print("    Không chunk nào đổi.")

    # ---------- Reload backend ----------
    if not args.no_reload:
        print("\n[5] Gọi backend reload ...")
        try:
            import httpx
            # secret nội bộ do backend tạo (rag_api/.rebuild_secret) — reload
            # giờ là endpoint admin, script local dùng secret thay token
            secret_file = Path(__file__).resolve().parent / "rag_api" / ".rebuild_secret"
            headers = {}
            if secret_file.exists():
                headers["X-Build-Secret"] = secret_file.read_text(encoding="utf-8").strip()
            r = httpx.post(f"{BACKEND}/api/corpus/reload", headers=headers, timeout=300)
            r.raise_for_status()
            print(f"    → {r.json()}")
        except Exception as e:
            print(f"    [WARN] Không reload được backend ({e}) — "
                  f"restart tay: uvicorn rag_api.main:app --port 8000")

    print(f"\n[DONE] Web đã cập nhật dữ liệu mới. "
          f"Có thể kiểm tra: .venv/bin/python demo_ollama.py --golden")
    return 0


if __name__ == "__main__":
    sys.exit(main())
