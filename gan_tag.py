"""
gan_tag.py
Gán tag_id vào metadata của chunks.jsonl theo 23 tag cố định
(bộ tag Phần 1 + Phần 2 + Phần 3).

Input : data/corpus/chunks.jsonl   (158 chunk, KHÔNG bị sửa)
Output: data/corpus/chunks_tagged.jsonl  (thêm 2 field: tags[], tag_primary)

- Phần 1 + Phần 2: 12 tag, ánh xạ 1 section mục lục → 1 tag.
- Phần 3: 11 tag mới cho chủ đề chưa có + cross-tag các mục trùng chủ đề
  Phần 2 (II→rèn luyện, IV→kỷ luật, V→chính sách, VI→vay vốn,
  XI→ngoại trú, XIII.6→học bổng+chính sách, Lịch tiếp→đơn vị).
- Mục XIII.1-5 (nộp học phí Viettel Money) → tag riêng #nop-hoc-phi.

Ánh xạ 100% rule deterministic theo heading (muc/chuong/phan) — không dùng LLM.
Run: .venv/bin/python gan_tag.py
"""

import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data" / "corpus"
INPUT_CHUNKS = DATA_DIR / "chunks.jsonl"
INPUT_TAGS = DATA_DIR / "tags.json"
OUTPUT_CHUNKS = DATA_DIR / "chunks_tagged.jsonl"
GOLDEN_QA = DATA_DIR / "golden_qa.json"

EXPECTED_N_TAGS = 23

# ---------------------------------------------------------------
# RULE A — primary tag theo heading.muc
# ---------------------------------------------------------------
# Mỗi rule: (muc_prefix, [tag_id, ...]). Áp dụng theo thứ tự; match đầu tiên thắng.
RULES = [
    # --- PHẦN 1 ---
    ("1. GIỚI THIỆU CHUNG", ["gioi-thieu-truong"]),
    ("2. ĐỘI NGŨ, CƠ CẤU TỔ CHỨC", ["co-cau-to-chuc"]),
    ("3. CÁC KÊNH THÔNG TIN ONLINE DÀNH CHO SINH VIÊN", ["kenh-thong-tin-online"]),
    ("4. ĐỊA CHỈ, ĐIỆN THOẠI CÁC ĐƠN VỊ THỰC HIỆN CÔNG TÁC SINH VIÊN",
     ["don-vi-cong-tac-sinh-vien"]),
    # --- PHẦN 2 ---
    ("PHẦN 2.1.", ["quy-che-dao-tao"]),
    ("PHẦN 2.2.", ["chuan-dau-ra-ngoai-ngu"]),
    ("PHẦN 2.3.", ["danh-gia-ren-luyen"]),
    ("PHẦN 2.4.", ["ky-luat-sinh-vien"]),
    ("PHẦN 2.5.", ["hoc-bong"]),
    ("PHẦN 2.6.", ["che-do-chinh-sach"]),
    ("PHẦN 2.7.", ["vay-von-tin-dung"]),
    ("PHẦN 2.8.", ["sinh-vien-ngoai-tru"]),
    # --- PHẦN 3: mục trùng chủ đề → cross-tag tag cũ ---
    ("II. ĐÁNH GIÁ RÈN LUYỆN", ["danh-gia-ren-luyen"]),
    ("IV. QUY TRÌNH KỶ LUẬT", ["ky-luat-sinh-vien"]),
    ("V. QUY TRÌNH CẤP GIẤY XÁC NHẬN CHẾ ĐỘ", ["che-do-chinh-sach"]),
    ("VI. QUY TRÌNH CẤP GIẤY XÁC NHẬN VAY VỐN", ["vay-von-tin-dung"]),
    ("XI. THỦ TỤC ĐĂNG KÝ VÀ CẤP XÁC NHẬN", ["sinh-vien-ngoai-tru"]),
    # --- PHẦN 3: chủ đề mới → tag mới ---
    ("I. TÀI KHOẢN", ["tai-khoan-qldt"]),
    ("III. ĐÁNH GIÁ CỐ VẤN", ["danh-gia-co-van"]),
    ("VII. QUY TRÌNH CẤP THẺ", ["the-sinh-vien"]),
    ("VIII. HOẠT ĐỘNG SINH VIÊN", ["hoat-dong-doan-hoi"]),
    ("IX. TRUNG TÂM THÔNG TIN", ["thu-vien"]),
    ("X. KÝ TÚC XÁ", ["ky-tuc-xa"]),
    ("XII. CHĂM SÓC Y TẾ", ["bao-hiem-y-te"]),
    ("XIII. HỌC PHÍ", ["nop-hoc-phi"]),
    ("XIV. EMAIL SINH VIÊN", ["email-sinh-vien"]),
    ("XV. TÀI LIỆU HƯỚNG DẪN CÀI ĐẶT", ["app-eutc"]),
    ("XVI. QUẢN LÝ HỒ SƠ", ["quan-ly-ho-so"]),
]

# Rule theo heading.chuong — override multi-tag cho mục XIII.6 (phát học bổng)
CHUONG_RULES = [
    ("XIII. HỌC PHÍ", "6. Phát học bổng", ["hoc-bong", "che-do-chinh-sach"]),
]

# Rule theo heading.phan — mục không có muc (Lịch tiếp sinh viên)
PHAN_RULES = [
    ("LỊCH TIẾP", ["don-vi-cong-tac-sinh-vien"]),
]

# Số chunk có tag_primary = tag_id (đối chiếu khi verify)
EXPECTED_COUNTS = {
    # --- Phần 1 + 2 (không đổi so batch trước) ---
    "gioi-thieu-truong": 3,
    "co-cau-to-chuc": 1,
    "kenh-thong-tin-online": 1,
    "don-vi-cong-tac-sinh-vien": 5,      # 2 (Phần 1) + 3 (Lịch tiếp)
    "quy-che-dao-tao": 49,
    "chuan-dau-ra-ngoai-ngu": 6,
    "danh-gia-ren-luyen": 12,            # 8 (Phần 2.3) + 4 (Phần 3.II)
    "ky-luat-sinh-vien": 8,              # 3 (Phần 2.4) + 5 (Phần 3.IV)
    "hoc-bong": 5,                       # 4 (Phần 2.5) + 1 (Phần 3.XIII.6, multi)
    "che-do-chinh-sach": 12,             # 11 (Phần 2.6) + 1 (Phần 3.V)
    "vay-von-tin-dung": 7,               # 6 (Phần 2.7) + 1 (Phần 3.VI)
    "sinh-vien-ngoai-tru": 5,            # 4 (Phần 2.8) + 1 (Phần 3.XI)
    # --- Phần 3: tag mới ---
    "tai-khoan-qldt": 3,                 # Phần 3.I
    "danh-gia-co-van": 2,                # Phần 3.III
    "the-sinh-vien": 3,                  # Phần 3.VII
    "hoat-dong-doan-hoi": 7,             # Phần 3.VIII
    "thu-vien": 8,                       # Phần 3.IX
    "ky-tuc-xa": 4,                      # Phần 3.X
    "bao-hiem-y-te": 3,                  # Phần 3.XII
    "nop-hoc-phi": 4,                    # Phần 3.XIII.1-5
    "email-sinh-vien": 2,                # Phần 3.XIV
    "app-eutc": 4,                       # Phần 3.XV
    "quan-ly-ho-so": 2,                  # Phần 3.XVI
}
EXPECTED_TAGGED_TOTAL = 156   # 98 (Phần 1+2) + 55 (Phần 3) + 3 (Lịch tiếp)
EXPECTED_UNTAGGED = 2         # Lời nói đầu

# Quy phạm truy vấn: câu golden trông đợi tag nào (smoke-test)
GOLDEN_EXPECTED_TAG = {
    # --- Phần 2 ---
    "q01": "hoc-bong", "q02": "hoc-bong", "q03": "hoc-bong",
    "q04": "che-do-chinh-sach", "q05": "che-do-chinh-sach",
    "q06": "vay-von-tin-dung", "q07": "vay-von-tin-dung",
    "q08": "sinh-vien-ngoai-tru",
    "q11": "danh-gia-ren-luyen",
    "q12": "ky-luat-sinh-vien", "q13": "ky-luat-sinh-vien", "q14": "ky-luat-sinh-vien",
    "q15": "quy-che-dao-tao", "q16": "quy-che-dao-tao", "q17": "quy-che-dao-tao",
    "q18": "quy-che-dao-tao",
    "q19": "chuan-dau-ra-ngoai-ngu",
    "q20": "quy-che-dao-tao",
    "q30": "don-vi-cong-tac-sinh-vien",
    # --- Phần 3 ---
    "q09": "ky-tuc-xa", "q10": "ky-tuc-xa",
    "q21": "tai-khoan-qldt",
    "q22": "app-eutc", "q23": "app-eutc",
    "q24": "email-sinh-vien",
    "q25": "nop-hoc-phi",
    "q26": "the-sinh-vien",
    "q27": "thu-vien",
    "q28": "bao-hiem-y-te",
    "q29": "don-vi-cong-tac-sinh-vien",
}


def assign_tags(chunk: dict) -> list[str]:
    """Trả về danh sách tag_id cho 1 chunk ([] nếu ngoài phạm vi)."""
    h = chunk.get("heading") or {}
    muc = h.get("muc", "") or ""
    chuong = h.get("chuong", "") or ""
    phan = h.get("phan", "") or ""

    # 1. Rule theo chuong (override multi-tag) — kiểm trước
    for muc_prefix, chuong_prefix, tag_ids in CHUONG_RULES:
        if muc.startswith(muc_prefix) and chuong.startswith(chuong_prefix):
            return list(tag_ids)

    # 2. Rule theo muc
    for prefix, tag_ids in RULES:
        if muc.startswith(prefix):
            return list(tag_ids)

    # 3. Rule theo phan (mục không có muc)
    for prefix, tag_ids in PHAN_RULES:
        if phan.startswith(prefix):
            return list(tag_ids)

    return []


def load_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    # ---------- 1. Load ----------
    tags_doc = load_json(INPUT_TAGS)
    valid_ids = {t["id"] for t in tags_doc["tags"]}
    if len(valid_ids) != EXPECTED_N_TAGS:
        print(f"[FAIL] tags.json có {len(valid_ids)} tag, mong đợi {EXPECTED_N_TAGS}")
        return 1

    with open(INPUT_CHUNKS, encoding="utf-8") as f:
        chunks = [json.loads(line) for line in f if line.strip()]
    print(f"Đọc {len(chunks)} chunk từ {INPUT_CHUNKS.name}")

    # ---------- 2. Gán tag ----------
    errors = []
    for c in chunks:
        tag_ids = assign_tags(c)
        for tid in tag_ids:
            if tid not in valid_ids:
                errors.append(f"{c['id']}: tag '{tid}' không có trong tags.json")
        tag_ids = [t for t in tag_ids if t in valid_ids]
        c["tags"] = tag_ids
        c["tag_primary"] = tag_ids[0] if tag_ids else None

    if errors:
        for e in errors:
            print(f"[FAIL] {e}")
        return 1

    # ---------- 3. Verify ----------
    from collections import Counter
    counts = Counter(c["tag_primary"] for c in chunks if c["tag_primary"])
    print(f"\n--- Phân bố tag ({len(EXPECTED_COUNTS)} tag) ---")
    for tid, want in EXPECTED_COUNTS.items():
        got = counts.get(tid, 0)
        flag = "OK " if got == want else "SAI"
        print(f"  [{flag}] {tid:<28} {got:>3}  (mong đợi {want})")
        if got != want:
            errors.append(f"{tid}: {got} != {want}")
    untagged = sum(1 for c in chunks if not c["tags"])
    tagged = len(chunks) - untagged
    print(f"  có tag: {tagged} | không tag: {untagged}")
    if tagged != EXPECTED_TAGGED_TOTAL:
        errors.append(f"tổng có tag = {tagged}, mong đợi {EXPECTED_TAGGED_TOTAL}")
    if untagged != EXPECTED_UNTAGGED:
        errors.append(f"tổng không tag = {untagged}, mong đợi {EXPECTED_UNTAGGED}")

    # multi-tag (chunk có >1 tag)
    multi = [c for c in chunks if len(c["tags"]) > 1]
    print(f"  multi-tag: {len(multi)} chunk"
          + (f" ({', '.join(c['id'] for c in multi)})" if multi else ""))

    # assert: mọi chunk Phần 1+2+3 và LỊCH TIẾP phải có tag
    for c in chunks:
        h = c.get("heading") or {}
        p = (h.get("phan") or "")
        in_scope = (p.startswith("PHẦN 1") or p.startswith("PHẦN 2")
                    or p.startswith("PHẦN 3") or p.startswith("LỊCH TIẾP"))
        if in_scope and not c["tag_primary"]:
            errors.append(f"{c['id']}: trong phạm vi nhưng không có tag "
                          f"(phan={p!r}, muc={h.get('muc')!r})")

    # ---------- 4. Smoke-test với golden_qa ----------
    print(f"\n--- Smoke-test golden_qa ({len(GOLDEN_EXPECTED_TAG)} câu) ---")
    golden = load_json(GOLDEN_QA)
    pass_n = fail_n = 0
    for q in golden:
        expect = GOLDEN_EXPECTED_TAG.get(q["id"])
        if not expect:
            continue
        pages = set(q["pages"])
        hits = [
            c for c in chunks
            if expect in c["tags"]
            and not pages.isdisjoint(range(c["page_start"], c["page_end"] + 1))
        ]
        ok = bool(hits)
        pass_n += ok
        fail_n += (not ok)
        print(f"  [{'PASS' if ok else 'FAIL'}] {q['id']} [{expect}] {q['question'][:58]}"
              f"  → {len(hits)} chunk")
    print(f"  => {pass_n} pass / {fail_n} fail")
    if fail_n:
        errors.append(f"smoke-test: {fail_n} câu FAIL")

    # ---------- 5. Ghi output ----------
    if errors:
        print("\n[ABORT] Có lỗi, KHÔNG ghi output:")
        for e in errors:
            print(f"  - {e}")
        return 1

    with open(OUTPUT_CHUNKS, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"\n[OK] Đã ghi {len(chunks)} chunk → {OUTPUT_CHUNKS}")

    # ---------- 6. Sample 2 chunk/tag ----------
    print("\n--- Sample (2 đầu / 2 cuối mỗi tag) ---")
    for tid in EXPECTED_COUNTS:
        grp = [c for c in chunks if c["tag_primary"] == tid]
        for c in grp[:2] + grp[-2:]:
            print(f"  {tid:<28} {c['id']} p.{c['page_start']}-{c['page_end']} "
                  f"| {(c['heading'].get('dieu') or c['heading'].get('muc') or '')[:52]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
