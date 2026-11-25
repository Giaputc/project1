"""
Compatibility shim — lớp lưu JSON-lines thực tế nằm ở packages/backend/core.

Giữ import `from rag_api.store import ...` của các module nghiệp vụ không phải
sửa khi tách package dùng chung.
"""

from frm_core.store import DATA_DIR, JsonlStore, now

__all__ = ["JsonlStore", "DATA_DIR", "now"]
