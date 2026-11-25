"""
paths.py — Định vị các thư mục gốc của monorepo (tách khỏi code nghiệp vụ).

Mọi app (API/web) và script CLI đều dùng chung các hằng số này thay vì
đoán đường dẫn bằng `Path(__file__).parent.parent`.
"""

from __future__ import annotations

from pathlib import Path

# frm_core/paths.py → packages/backend/core/src/frm_core → repo root
ROOT = Path(__file__).resolve().parents[5]

APPS_DIR = ROOT / "apps"
API_DIR = APPS_DIR / "api"
WEB_DIR = APPS_DIR / "web"

PACKAGES_DIR = ROOT / "packages"
SCRIPTS_DIR = ROOT / "scripts"
DOCS_DIR = ROOT / "docs"

# Dữ liệu nghiệp vụ (JSON-lines, corpus) — nguồn sự thật chung của hệ thống.
DATA_DIR = ROOT / "data"
CORPUS_DIR = DATA_DIR / "corpus"
