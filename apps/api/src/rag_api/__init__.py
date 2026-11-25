"""
rag_api — FastAPI app (apps/api).

Khi chạy app/script từ repo root, cần đưa `packages/backend/core/src` vào
sys.path để import được `frm_core`. Việc này làm ở đây để không phải đặt
PYTHONPATH thủ công ở từng lệnh.
"""

from __future__ import annotations

import sys
from pathlib import Path

# rag_api/__init__.py → apps/api/src/rag_api → root
_CORE_SRC = Path(__file__).resolve().parents[4] / "packages" / "backend" / "core" / "src"
if str(_CORE_SRC) not in sys.path:
    sys.path.insert(0, str(_CORE_SRC))
