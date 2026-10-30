"""
chungkinh.py
Chunk file Sổ tay sinh viên ĐH GTVT theo cấu trúc heading.
XÓA ẢNH, BỎ BÌA + MỤC LỤC.
"""

import re
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
INPUT_MD = DATA_DIR / "so_tay_sinh_vien_k64.md"
OUTPUT_JSON = BASE_DIR / "chunks.json"


# ============================================================
# BƯỚC 1: LÀM SẠCH
# ============================================================

def clean_md(text: str) -> str:
    # 1. Xóa ảnh
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)
    # 2. Xóa GHI CHÉP
    text = re.sub(r'\n# GHI CHÉP.*$', '', text, flags=re.DOTALL)
    # 3. Xóa dòng toàn dấu chấm
    text = re.sub(r'^[\.\s]+$', '', text, flags=re.MULTILINE)
    # 4. Gộp dòng trống
    text = re.sub(r'\n{3,}', '\n\n', text)
    # 5. Bỏ phần bìa + mục lục: từ đầu đến trước "# LỜI NÓI ĐẦU"
    match = re.search(r'# LỜI NÓI ĐẦU', text)
    if match:
        text = text[match.start():]
    return text.strip()


# ============================================================
# BƯỚC 2: CHUNKING
# ============================================================

def chunk_by_structure(text: str, source: str = "so_tay_sinh_vien_k64.md",
                       max_size: int = 1200) -> list:
    lines = text.split('\n')
    chunks = []

    current_phan = ""
    current_muc = ""
    current_chuong = ""
    current_dieu_title = ""
    current_dieu_lines = []

    # Buffer cho nội dung NGOÀI Điều (thuộc mục hiện tại)
    current_muc_body = []

    def flush_dieu():
        nonlocal current_dieu_lines, current_dieu_title
        if not current_dieu_lines:
            return
        body = '\n'.join(current_dieu_lines).strip()
        current_dieu_lines = []
        if len(body) < 50:
            return

        if len(body) <= max_size:
            chunks.append(_make_chunk(
                text=body, source=source, phan=current_phan,
                muc=current_muc, chuong=current_chuong,
                dieu=current_dieu_title, index=len(chunks),
            ))
        else:
            sub_parts = re.split(r'(?=\n(?:\d+\.\s|[a-zđ]\)\s))', body)
            for i, part in enumerate(sub_parts):
                part = part.strip()
                if len(part) < 30:
                    continue
                if i > 0 and current_dieu_title:
                    part = f"[{current_dieu_title}]\n{part}"
                chunks.append(_make_chunk(
                    text=part, source=source, phan=current_phan,
                    muc=current_muc, chuong=current_chuong,
                    dieu=current_dieu_title, index=len(chunks),
                ))

    def flush_muc_body():
        """Đẩy nội dung ngoài Điều (thuộc mục) thành 1 chunk."""
        nonlocal current_muc_body
        if not current_muc_body:
            return
        body = '\n'.join(current_muc_body).strip()
        current_muc_body = []
        if len(body) < 50:
            return
        # Nếu quá dài -> cắt theo đoạn văn
        if len(body) <= max_size:
            chunks.append(_make_chunk(
                text=body, source=source, phan=current_phan,
                muc=current_muc, chuong=current_chuong,
                dieu="", index=len(chunks),
            ))
        else:
            parts = re.split(r'\n\n', body)
            buf = ""
            for p in parts:
                p = p.strip()
                if not p:
                    continue
                if len(buf) + len(p) + 2 <= max_size:
                    buf = (buf + "\n\n" + p).strip() if buf else p
                else:
                    if buf:
                        chunks.append(_make_chunk(
                            text=buf, source=source, phan=current_phan,
                            muc=current_muc, chuong=current_chuong,
                            dieu="", index=len(chunks),
                        ))
                    buf = p
            if buf:
                chunks.append(_make_chunk(
                    text=buf, source=source, phan=current_phan,
                    muc=current_muc, chuong=current_chuong,
                    dieu="", index=len(chunks),
                ))

    for line in lines:
        stripped = line.strip()

        if stripped.startswith('# ') and not stripped.startswith('## '):
            flush_dieu()
            flush_muc_body()
            current_phan = stripped[2:].strip()
            current_muc = ""
            current_chuong = ""
            continue

        if stripped.startswith('## ') and not stripped.startswith('### '):
            flush_dieu()
            flush_muc_body()
            current_muc = stripped[3:].strip()
            current_chuong = ""
            continue

        if stripped.startswith('### ') and not stripped.startswith('#### '):
            flush_dieu()
            flush_muc_body()
            current_chuong = stripped[4:].strip()
            continue

        if stripped.startswith('#### '):
            flush_dieu()
            flush_muc_body()
            current_dieu_title = stripped[5:].strip()
            current_dieu_lines = [stripped]
            continue

        # Nội dung
        if current_dieu_title:
            current_dieu_lines.append(line)
        elif stripped:
            current_muc_body.append(line)

    flush_dieu()
    flush_muc_body()
    return chunks


def _make_chunk(text, source, phan, muc, chuong, dieu, index):
    return {
        "id": f"chunk_{index:04d}",
        "text": text,
        "metadata": {
            "source": source,
            "phan": phan,
            "muc": muc,
            "chuong": chuong,
            "dieu": dieu,
            "tags": [],
            "weight": 1.0,
            "chunk_index": index,
            "char_count": len(text),
        },
    }


# ============================================================
# THỐNG KÊ
# ============================================================

def chunk_stats(chunks):
    lengths = [c["metadata"]["char_count"] for c in chunks]
    print(f"Tổng chunk: {len(chunks)}")
    if not lengths:
        return
    print(f"Min: {min(lengths)} | Max: {max(lengths)} | TB: {sum(lengths)//len(lengths)}")
    short = [c for c in chunks if c["metadata"]["char_count"] < 100]
    long_ = [c for c in chunks if c["metadata"]["char_count"] > 2000]
    print(f"Chunk quá ngắn (<100): {len(short)}")
    print(f"Chunk quá dài (>2000): {len(long_)}")


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    print(f"Đọc file: {INPUT_MD}")
    if not INPUT_MD.exists():
        raise FileNotFoundError(f"Không tìm thấy: {INPUT_MD}")

    with open(INPUT_MD, "r", encoding="utf-8") as f:
        raw = f.read()

    cleaned = clean_md(raw)
    chunks = chunk_by_structure(cleaned)

    chunk_stats(chunks)

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)

    print(f"\nĐã xuất: {OUTPUT_JSON}")

    for c in chunks[:3]:
        print("=" * 60)
        print(c["id"], "|", c["metadata"]["muc"], "|", c["metadata"]["dieu"])
        print(c["text"][:300])