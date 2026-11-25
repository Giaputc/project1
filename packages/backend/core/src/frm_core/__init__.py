"""Shared backend core cho app FastAPI và các script CLI."""

from .paths import (
    API_DIR,
    APPS_DIR,
    CORPUS_DIR,
    DATA_DIR,
    DOCS_DIR,
    PACKAGES_DIR,
    ROOT,
    SCRIPTS_DIR,
    WEB_DIR,
)
from .store import JsonlStore, now

__all__ = [
    "JsonlStore",
    "now",
    "ROOT",
    "APPS_DIR",
    "API_DIR",
    "WEB_DIR",
    "PACKAGES_DIR",
    "SCRIPTS_DIR",
    "DOCS_DIR",
    "DATA_DIR",
    "CORPUS_DIR",
]
