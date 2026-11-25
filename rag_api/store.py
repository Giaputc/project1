"""
store.py — Lưu JSON-lines dùng chung cho các kho dữ liệu nghiệp vụ.

Mỗi dòng là 1 bản ghi JSON. Ghi qua file tạm + replace để tránh file hỏng
khi request đồng thời. Các module (history/feedback/hangcho) cũ giữ nguyên;
module mới dùng chung cái này cho gọn.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class JsonlStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()

    def all(self) -> list[dict]:
        if not self.path.exists():
            return []
        out: list[dict] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                if isinstance(row, dict):
                    out.append(row)
            except json.JSONDecodeError:
                continue
        return out

    def append(self, rec: dict) -> dict:
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec

    def write_all(self, rows: list[dict]) -> None:
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(
                "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                encoding="utf-8",
            )
            tmp.replace(self.path)

    def find(self, predicate: Callable[[dict], bool]) -> Optional[dict]:
        with self.lock:
            return next((r for r in self.all() if predicate(r)), None)

    def update(self, predicate: Callable[[dict], bool],
               mutate: Callable[[dict], None]) -> Optional[dict]:
        """Sửa bản ghi đầu tiên thỏa predicate; trả None nếu không có."""
        with self.lock:
            rows = self.all()
            hit = next((r for r in rows if predicate(r)), None)
            if hit is None:
                return None
            mutate(hit)
            self.write_all(rows)
            return hit

    def delete(self, predicate: Callable[[dict], bool]) -> int:
        with self.lock:
            rows = self.all()
            keep = [r for r in rows if not predicate(r)]
            removed = len(rows) - len(keep)
            if removed:
                self.write_all(keep)
            return removed
