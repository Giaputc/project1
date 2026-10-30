"""
auth.py — Đăng nhập & phân quyền (Admin / Khách) cho RAG API.

- Người dùng trong users.json (seed admin/admin123, đổi bằng env
  ADMIN_USERNAME/ADMIN_PASSWORD khi file chưa tồn tại).
- Token: sinh ngẫu nhiên, lưu server-side RAM, hạn 24h.
- Guest: POST /api/auth/guest — 1 nút vào, không mật khẩu.
- require_admin: dependency cho endpoint admin (401 thiếu token, 403 sai role).
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, Header, HTTPException

USERS_FILE = Path(__file__).resolve().parent / "users.json"
TOKEN_TTL_S = 24 * 3600

# token -> {"role", "username", "display", "exp"}
_SESSIONS: dict[str, dict] = {}

# ---------------------------------------------------------------
# users.json — seed admin 1 lần
# ---------------------------------------------------------------
def _hash(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode("utf-8")).hexdigest()


def _ensure_seed() -> None:
    if USERS_FILE.exists():
        return
    admin = os.getenv("ADMIN_USERNAME", "admin")
    pw = os.getenv("ADMIN_PASSWORD", "admin123")
    salt = secrets.token_hex(8)
    users = [{
        "username": admin,
        "salt": salt,
        "password_hash": _hash(pw, salt),
        "role": "admin",
        "display": "Admin",
    }]
    USERS_FILE.write_text(
        json.dumps({"users": users}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"🆕 Đã tạo {USERS_FILE.name} — admin mặc định: {admin}/{pw} "
          f"(đổi bằng env ADMIN_USERNAME/ADMIN_PASSWORD hoặc sửa file)")


def _load_users() -> list[dict]:
    _ensure_seed()
    try:
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))["users"]
    except Exception:
        return []


# ---------------------------------------------------------------
# Token lifecycle
# ---------------------------------------------------------------
def _issue(username: str, role: str, display: str) -> str:
    tok = secrets.token_urlsafe(32)
    _SESSIONS[tok] = {"role": role, "username": username,
                      "display": display, "exp": time.time() + TOKEN_TTL_S}
    return tok


def login(username: str, password: str) -> Optional[dict]:
    """Trả {token, role, display} hoặc None (sai thông tin)."""
    for u in _load_users():
        if u["username"] == username and \
                _hash(password, u["salt"]) == u["password_hash"]:
            tok = _issue(username, u["role"], u.get("display", username))
            return {"token": tok, "role": u["role"],
                    "display": u.get("display", username)}
    return None


def issue_guest() -> dict:
    tok = _issue("khach", "guest", "Khách")
    return {"token": tok, "role": "guest", "display": "Khách"}


def _current(authorization: Optional[str]) -> Optional[dict]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    tok = authorization[7:].strip()
    s = _SESSIONS.get(tok)
    if not s:
        return None
    if s["exp"] < time.time():                 # hết hạn → xoá
        _SESSIONS.pop(tok, None)
        return None
    return s


def require_admin(authorization: Optional[str] = Header(default=None)) -> dict:
    """Dependency: 401 nếu thiếu/không hợp lệ, 403 nếu không phải admin."""
    s = _current(authorization)
    if s is None:
        raise HTTPException(401, "Thiếu hoặc token không hợp lệ")
    if s["role"] != "admin":
        raise HTTPException(403, "Chỉ admin mới có quyền này")
    return s


def optional_admin(authorization: Optional[str] = Header(default=None)) -> Optional[dict]:
    """Dependency: trả session nếu là admin, ngược lại None (không lỗi)."""
    s = _current(authorization)
    return s if s and s["role"] == "admin" else None


def current_role(authorization: Optional[str] = Header(default=None)) -> Optional[dict]:
    """Dependency optional: trả session (role) hoặc None — dùng để bỏ qua
    params của guest mà không chặn request."""
    return _current(authorization)
