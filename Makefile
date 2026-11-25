# Makefile — điều phối monorepo (lấy cảm hứng từ frm-stack/justfile).
# Mục tiêu: một lệnh cho mỗi app, không cần nhớ PYTHONPATH hay cd thủ công.

PYTHON := .venv/bin/python
UVICORN := .venv/bin/uvicorn

# apps/api  → import rag_api
# packages/backend/core/src → import frm_core (store/paths dùng chung)
# scripts   → pipeline RAG CLI (demo_ollama, gan_tag, rebuild)
export PYTHONPATH := apps/api/src:packages/backend/core/src:scripts:$(PYTHONPATH)

.PHONY: dev dev-api dev-web check smoke rebuild rebuild-dry

dev:
	$(MAKE) -j2 dev-api dev-web

dev-api:
	$(UVICORN) rag_api.main:app --reload --port 8000

dev-web:
	cd apps/web && npm run dev

check:
	$(PYTHON) -m compileall -q apps/api/src packages/backend/core/src scripts
	cd apps/web && npx tsc --noEmit && npm run lint

smoke:
	$(PYTHON) -c "from fastapi.testclient import TestClient; from rag_api.main import app; r=TestClient(app).get('/health'); print(r.status_code, r.json()['corpus'])"

rebuild:
	$(PYTHON) scripts/rebuild.py

rebuild-dry:
	$(PYTHON) scripts/rebuild.py --dry-run
