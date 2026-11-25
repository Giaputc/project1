"""
auth.py — Đăng nhập & phân quyền (Admin / Cán bộ tư vấn / Khách) cho RAG API.

- Người dùng trong users.json (seed admin/admin123 + canbo/canbo123 khi file
  chưa có role can_bo; đổi bằng env ADMIN_*/CANBO_*).
- Token: sinh ngẫu nhiên, lưu server-side RAM, hạn 24h.
- Guest: POST /api/auth/guest — 1 nút vào, không mật khẩu; mỗi client có
  guest_id riêng → username `khach_<id>` (không dùng chung `khach`).
- require_admin: endpoint admin (401 thiếu token, 403 sai role).
- require_staff: endpoint cán bộ + admin (xem/trả lời hàng chờ).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, Header, HTTPException

USERS_FILE = Path(__file__).resolve().parent / "users.json"
TOKEN_TTL_S = 24 * 3600

STAFF_ROLES = ("admin", "can_bo")

# Guest: mỗi browser/client 1 id riêng → lịch sử & thông báo không lẫn nhau.
GUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Vai trò theo sơ đồ use case: Sinh viên / Cán bộ tư vấn / Quản trị viên.
# 'guest' là token ngắn hạn của sinh viên chưa đăng nhập (khác 'sinh_vien').
ROLES = {
    "admin": "Quản trị viên",
    "can_bo": "Cán bộ tư vấn",
    "sinh_vien": "Sinh viên",
    "guest": "Khách",
}

# Ma trận phân quyền — dùng cho cả API (require_permission) lẫn UI.
PERMISSIONS: dict[str, tuple[str, ...]] = {
    "admin": (
        "chat_params", "manage_tags", "staff_queue", "propose_doc",
        "approve_doc", "review_answer", "approve_answer", "manage_users",
        "manage_topics", "view_reports", "rebuild",
    ),
    "can_bo": (
        "staff_queue", "propose_doc", "review_answer", "view_reports",
    ),
    "sinh_vien": (),
    "guest": (),
}

# token -> {"role", "username", "display", "exp"}
_SESSIONS: dict[str, dict] = {}
_USERS_LOCK = threading.RLock()

# ---------------------------------------------------------------
# users.json — seed admin 1 lần
# ---------------------------------------------------------------
def _hash(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode("utf-8")).hexdigest()


def _seed_admin() -> dict:
    admin = os.getenv("ADMIN_USERNAME", "admin")
    pw = os.getenv("ADMIN_PASSWORD", "admin123")
    salt = secrets.token_hex(8)
    return {
        "username": admin,
        "salt": salt,
        "password_hash": _hash(pw, salt),
        "role": "admin",
        "display": "Admin",
    }


def _seed_canbo() -> dict:
    name = os.getenv("CANBO_USERNAME", "canbo")
    pw = os.getenv("CANBO_PASSWORD", "canbo123")
    salt = secrets.token_hex(8)
    return {
        "username": name,
        "salt": salt,
        "password_hash": _hash(pw, salt),
        "role": "can_bo",
        "display": "Cán bộ tư vấn",
    }


def _ensure_seed() -> None:
    if not USERS_FILE.exists():
        users = [_seed_admin(), _seed_canbo()]
        USERS_FILE.write_text(
            json.dumps({"users": users}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        print(f"🆕 Đã tạo {USERS_FILE.name} — "
              f"admin {users[0]['username']}/{os.getenv('ADMIN_PASSWORD', 'admin123')} · "
              f"cán bộ {users[1]['username']}/{os.getenv('CANBO_PASSWORD', 'canbo123')} "
              f"(đổi bằng env ADMIN_*/CANBO_*)")
        return

    # file đã có nhưng chưa có role can_bo → bổ sung (không ghi đè user khác)
    try:
        data = json.loads(USERS_FILE.read_text(encoding="utf-8"))
        users = data.get("users", [])
    except Exception:
        return
    if any(u.get("role") == "can_bo" for u in users):
        return
    users.append(_seed_canbo())
    USERS_FILE.write_text(
        json.dumps({"users": users}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"➕ Đã bổ sung tài khoản cán bộ vào {USERS_FILE.name} — "
          f"{os.getenv('CANBO_USERNAME', 'canbo')}/"
          f"{os.getenv('CANBO_PASSWORD', 'canbo123')}")


def _load_users() -> list[dict]:
    with _USERS_LOCK:
        _ensure_seed()
        try:
            return json.loads(USERS_FILE.read_text(encoding="utf-8"))["users"]
        except Exception:
            return []


def _save_users(users: list[dict]) -> None:
    with _USERS_LOCK:
        tmp = USERS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"users": users}, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        tmp.replace(USERS_FILE)


def has_permission(role: Optional[str], perm: str) -> bool:
    return bool(role) and perm in PERMISSIONS.get(role or "", ())


def public_roles() -> list[dict]:
    """Danh sách vai trò cho form quản trị người dùng."""
    return [{"id": k, "name": v} for k, v in ROLES.items() if k != "guest"]


def list_users() -> list[dict]:
    """Danh sách người dùng — không trả salt/hash mật khẩu."""
    return [
        {"username": u.get("username"), "display": u.get("display") or u.get("username"),
         "role": u.get("role", "sinh_vien")}
        for u in _load_users()
    ]


def add_user(username: str, password: str, role: str,
             display: Optional[str] = None) -> dict:
    name = (username or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,50}", name):
        raise ValueError("Tài khoản: 3-50 ký tự, chữ/số/_/./-")
    if len(password or "") < 6:
        raise ValueError("Mật khẩu tối thiểu 6 ký tự")
    if role not in ROLES or role == "guest":
        raise ValueError("Vai trò không hợp lệ")
    with _USERS_LOCK:
        users = _load_users()
        if any(u.get("username") == name for u in users):
            raise ValueError("Tài khoản đã tồn tại")
        salt = secrets.token_hex(8)
        users.append({
            "username": name, "salt": salt,
            "password_hash": _hash(password, salt),
            "role": role, "display": (display or name).strip()[:80],
        })
        _save_users(users)
    return {"username": name, "display": (display or name).strip()[:80],
            "role": role}


def update_user(username: str, patch: dict, current: Optional[str] = None) -> dict:
    """Sửa display/role/mật khẩu. Không cho hạ quyền admin cuối cùng."""
    if not any(k in patch for k in ("display", "role", "password")):
        raise ValueError("Không có gì để cập nhật")
    role = patch.get("role")
    if role is not None and (role not in ROLES or role == "guest"):
        raise ValueError("Vai trò không hợp lệ")
    password = patch.get("password")
    if password is not None and len(str(password)) < 6:
        raise ValueError("Mật khẩu tối thiểu 6 ký tự")
    with _USERS_LOCK:
        users = _load_users()
        hit = next((u for u in users if u.get("username") == username), None)
        if hit is None:
            raise ValueError("Không tìm thấy người dùng")
        if hit.get("role") == "admin" and role not in (None, "admin"):
            n_admin = sum(1 for u in users if u.get("role") == "admin")
            if n_admin <= 1:
                raise ValueError("Không thể hạ quyền quản trị viên cuối cùng")
        if "display" in patch:
            hit["display"] = str(patch["display"]).strip()[:80] or hit["username"]
        if role is not None:
            hit["role"] = role
        if password is not None:
            salt = secrets.token_hex(8)
            hit["salt"] = salt
            hit["password_hash"] = _hash(str(password), salt)
        _save_users(users)
    # token cũ mang role cũ → bắt đăng nhập lại để cập nhật quyền
    for tok, s in list(_SESSIONS.items()):
        if s.get("username") == username:
            _SESSIONS.pop(tok, None)
    return {"username": username, "display": hit.get("display"),
            "role": hit.get("role")}


def delete_user(username: str, current: Optional[str] = None) -> bool:
    if username == current:
        raise ValueError("Không thể xoá tài khoản đang dùng")
    with _USERS_LOCK:
        users = _load_users()
        hit = next((u for u in users if u.get("username") == username), None)
        if hit is None:
            return False
        if hit.get("role") == "admin":
            n_admin = sum(1 for u in users if u.get("role") == "admin")
            if n_admin <= 1:
                raise ValueError("Không thể xoá quản trị viên cuối cùng")
        _save_users([u for u in users if u.get("username") != username])
    for tok, s in list(_SESSIONS.items()):
        if s.get("username") == username:
            _SESSIONS.pop(tok, None)
    return True


# ---------------------------------------------------------------
# Token lifecycle
# ---------------------------------------------------------------
def _issue(username: str, role: str, display: str) -> str:
    tok = secrets.token_urlsafe(32)
    _SESSIONS[tok] = {"role": role, "username": username,
                      "display": display, "exp": time.time() + TOKEN_TTL_S}
    return tok


def login(username: str, password: str) -> Optional[dict]:
    """Trả {token, username, role, display} hoặc None (sai thông tin)."""
    for u in _load_users():
        if u["username"] == username and \
                _hash(password, u["salt"]) == u["password_hash"]:
            tok = _issue(username, u["role"], u.get("display", username))
            return {"token": tok, "username": username, "role": u["role"],
                    "display": u.get("display", username)}
    return None


def issue_guest(guest_id: Optional[str] = None) -> dict:
    """Phát token guest riêng theo guest_id của client.

    Không truyền guest_id → sinh id ngẫu nhiên (vẫn không dùng chung `khach`).
    username dạng `khach_<id>` để history/notifications tách theo từng client.
    """
    raw = (guest_id or "").strip()
    if raw.startswith("khach_"):
        raw = raw[len("khach_"):]
    if not GUEST_ID_RE.fullmatch(raw):
        raw = secrets.token_hex(8)
    username = f"khach_{raw}"
    tok = _issue(username, "guest", "Khách")
    return {"token": tok, "username": username,
            "role": "guest", "display": "Khách"}


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


def require_staff(authorization: Optional[str] = Header(default=None)) -> dict:
    """Dependency: 401 thiếu/không hợp lệ, 403 nếu không phải cán bộ/admin."""
    s = _current(authorization)
    if s is None:
        raise HTTPException(401, "Thiếu hoặc token không hợp lệ")
    if s["role"] not in STAFF_ROLES:
        raise HTTPException(403, "Chỉ cán bộ tư vấn hoặc admin mới có quyền này")
    return s


def require_login(authorization: Optional[str] = Header(default=None)) -> dict:
    """Dependency: bất kỳ ai đã đăng nhập (admin / cán bộ / khách)."""
    s = _current(authorization)
    if s is None:
        raise HTTPException(401, "Cần đăng nhập để dùng chức năng này")
    return s


def require_permission(perm: str):
    """Tạo dependency FastAPI kiểm tra 1 quyền trong ma trận PERMISSIONS."""
    def _dep(authorization: Optional[str] = Header(default=None)) -> dict:
        s = _current(authorization)
        if s is None:
            raise HTTPException(401, "Thiếu hoặc token không hợp lệ")
        if not has_permission(s.get("role"), perm):
            raise HTTPException(403, f"Vai trò {s.get('role')} không có quyền: {perm}")
        return s
    return _dep
