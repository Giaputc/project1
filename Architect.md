# Architect.md — Kiến trúc code

Tài liệu mô tả cách tổ chức code của dự án sau khi chuyển sang mô hình
**monorepo `apps/` + `packages/`**, lấy cảm hứng từ
[`frmlabz/frm-stack`](https://github.com/frmlabz/frm-stack).

Nguyên tắc chung của frm-stack: **app = thứ chạy được**, **package = thứ được
dùng lại**, **docs = tài liệu ngắn gọn**, **root = điều phối một lệnh**. Dự án
giữ nguyên stack hiện tại (FastAPI + Next.js + Ollama + JSON-lines), chỉ áp
dụng cách tổ chức đó — không chuyển sang Hono/oRPC/Postgres/pnpm.

---

## 1. Sơ đồ thư mục

```
project1/
├─ apps/
│  ├─ api/                       # FastAPI app (chạy được)
│  │  ├─ src/rag_api/            # modules nghiệp vụ 1.0 → 6.0
│  │  │  ├─ main.py              # route + auth dependency + hook tự chuyển cán bộ
│  │  │  ├─ rag_engine.py        # RAG singleton, SSE, inject đáp án đã duyệt
│  │  │  ├─ auth.py              # token, role, PERMISSIONS, phiên guest
│  │  │  ├─ history.py           # D1  lịch sử theo username
│  │  │  ├─ hangcho.py           # D3  hàng chờ cán bộ
│  │  │  ├─ feedback.py          # D4  👍/👎 + sao + nhận xét
│  │  │  ├─ reviews.py           # D4  cán bộ đánh giá hữu ích / admin phê duyệt
│  │  │  ├─ knowledge.py         # D3  đề xuất tài liệu → tri thức
│  │  │  ├─ notifications.py     # D5  chuông 🔔
│  │  │  ├─ catalog.py, reports.py
│  │  │  └─ store.py             # shim → frm_core.store (tương thích import cũ)
│  │  └─ SETUP.md
│  └─ web/                       # Next.js App Router (chạy được)
│     ├─ app/, components/, lib/
│     ├─ AGENTS.md               # do `next dev` tạo lại — không xoá
│     └─ SETUP.md
├─ packages/
│  └─ backend/core/              # package dùng chung (không chạy riêng)
│     └─ src/frm_core/
│        ├─ paths.py             # ROOT, DATA_DIR, API_DIR, WEB_DIR, SCRIPTS_DIR
│        └─ store.py             # JsonlStore + now()
├─ scripts/                      # CLI pipeline RAG (dùng bởi API lẫn rebuild)
│  ├─ demo_ollama.py             # pipeline gốc: embed, BM25+vector, LLM, prompt
│  ├─ gan_tag.py                 # rule deterministic gắn 23 tag + golden_qa
│  ├─ rebuild.py                 # .md → chunk → tag → embed đổi → reload API
│  └─ chungkinh.py                # tiện ích cắt chunk theo cấu trúc
├─ docs/
│  └─ setup.md                   # mục lục quickstart
├─ data/                         # nguồn sự thật (runtime, phần lớn ignore git)
│  ├─ so_tay_sinh_vien_k64.md    # input biên tập
│  ├─ corpus/                    # chunks, tags, cache embed, tri thức bổ sung
│  └─ *.json / *.jsonl           # D1/D3/D4/D5/D6
├─ Makefile                      # điều phối: dev-api, dev-web, check, rebuild...
├─ README.md                     # tính năng + API + luồng nghiệp vụ
├─ SETUP.md                      # cài đặt & chạy toàn hệ thống
└─ Architect.md                  # file này
```

> `frm-stack/` trong repo là bản clone repo tham khảo (untracked), giữ nguyên để
> đối chiếu; không phải package của ứng dụng.

---

## 2. Các app (`apps/`)

### `apps/api` — FastAPI

- Trách nhiệm: HTTP/SSE API, xác thực & phân quyền, điều phối nghiệp vụ,
  gọi pipeline RAG và ghi kho dữ liệu.
- Không chứa SQL/DB: mọi ghi đọc đi qua `frm_core.JsonlStore` hoặc module
  tương ứng trong `src/rag_api/`.
- `rag_api/__init__.py` tự đưa `packages/backend/core/src` vào `sys.path`, nên
  import `frm_core` hoạt động mà không cần đặt `PYTHONPATH` ở từng lệnh.
- `rag_engine.py` thêm `scripts/` vào `sys.path` rồi `import demo_ollama` —
  **dùng chung pipeline gốc, không copy logic**. Khi rebuild sửa chunk, chỉ cần
  reload corpus; không restart app.

### `apps/web` — Next.js

- Trách nhiệm: UI chat streaming, panel theo role, gọi API qua `lib/api.ts`.
- **Không đọc trực tiếp `data/`** — mọi dữ liệu đi qua HTTP API. Đây là ranh
  giới kiến trúc quan trọng: có thể thay backend sau này mà không sửa UI.
- `lib/api.ts` là API client + parser SSE; component chỉ chạy ở client (`"use client"`)
  đọc `localStorage` có guard `typeof window === "undefined"`.
- Phiên chat tách theo danh tính: `username` (admin/cán bộ/sinh viên) hoặc
  `khach_<guest_id>` (khách), khóa lưu `localStorage.rag_chat_<username>`.

---

## 3. Package dùng chung (`packages/backend/core`)

`frm_core` là phần tách được từ code nghiệp vụ:

| Module | Vai trò | Ai dùng |
|---|---|---|
| `paths.py` | Định vị `ROOT`, `DATA_DIR`, `CORPUS_DIR`, `API_DIR`, `WEB_DIR`, `SCRIPTS_DIR` | API, scripts, docs tooling sau này |
| `store.py` | `JsonlStore` (append / find / update / delete, atomic replace) + `now()` | `rag_api.store` shim, catalog, knowledge, reviews, notifications |

`apps/api/src/rag_api/store.py` chỉ là shim re-export để giữ nguyên các import
`from rag_api.store import ...`. Các module cũ (`history`, `hangcho`,
`feedback`) cũng đã dùng chung `DATA_DIR` từ package này thay vì tự đoán
`Path(__file__).parent.parent`.

**Luật phụ thuộc:** `apps/*` → `packages/*` → `data/`. Package không được
import ngược lại app. `apps/web` chỉ giao tiếp với `apps/api` qua HTTP.

---

## 4. Tầng dữ liệu (`data/`)

Không dùng database 13 bảng như đặc tả gốc; dùng JSON/JSONL để chạy offline,
dễ sửa tay, dễ test:

| Kho | File | Ghi bởi |
|---|---|---|
| D1 lịch sử | `data/lich_su.json` | `history.py` |
| D2 corpus | `data/corpus/chunks_tagged.jsonl`, `tags.json`, `cache/` | `scripts/rebuild.py`, `gan_tag.py` |
| D2 tri thức bổ sung | `data/corpus/cache/bosung_embeds_*.json` | `knowledge.py` / `reviews.decide()` |
| D3 hàng chờ, đề xuất | `data/hang_cho.json`, `data/tri_thuc.jsonl` | `hangcho.py`, `knowledge.py` |
| D4 đánh giá, rà soát | `data/danh_gia.json`, `data/ra_soat.jsonl` | `feedback.py`, `reviews.py` |
| D5 thông báo, user | `data/thong_bao.jsonl`, `apps/api/src/rag_api/users.json` | `notifications.py`, `auth.py` |
| D6 chủ đề | `data/chu_de.jsonl` | `catalog.py` |

Đáp án admin duyệt được **tiêm vào D2 qua `_inject_approved()`** và cache
embedding riêng — không ghi đè `chunks.jsonl`, nên `rebuild.py` vẫn là nguồn
tạo chunk duy nhất từ file `.md`.

---

## 5. Luồng dữ liệu chính

### 5.1 Chat RAG (1.0 → 2.0 → 3.0)

```
apps/web (SSE) → apps/api/main.py → auth (role/params)
        → rag_engine (router tag) → scripts/demo_ollama (BM25 + vector + LLM)
        → meta/token/done → apps/web render nguồn + chip tag
```

`OUT_OF_SCOPE` / hết nguồn / LLM lỗi → `hangcho.enqueue()` +
`notifications.broadcast_staff()`. `ASK_BACK` chỉ hỏi lại, không tự chuyển.

### 5.2 Học từ phản hồi (4.0)

```
Sinh viên: FeedbackBar → POST /api/feedback → data/danh_gia.json
        ≥4 sao + 👍 → reviews.enqueue() → data/ra_soat.jsonl
                    → notify danh_gia_moi cho cán bộ
Cán bộ:   KnowledgePanel 💬 xem sao/nhận xét
        → ⭐ Đánh giá → huu_ich=false → khong_huu_ich (dừng)
                       huu_ich=true  → da_rasoat (trình admin)
Admin:    /decide → knowledge.add_approved → inject D2 + reload corpus
```

### 5.3 Cập nhật sổ tay

```
data/so_tay_sinh_vien_k64.md
  → make rebuild → scripts/rebuild.py (diff chunk, backup)
  → scripts/gan_tag.py (23 tag + golden_qa, FAIL → rollback)
  → embed chỉ chunk đổi → POST /api/corpus/reload → web dùng ngay
```

---

## 6. Điều phối & lệnh (`Makefile`)

`Makefile` đóng vai trò tương đương `justfile`/root `package.json` của
frm-stack: một chỗ export `PYTHONPATH` và gọi app đúng thư mục.

| Lệnh | Việc làm |
|---|---|
| `make dev` | chạy API + web song song |
| `make dev-api` | `uvicorn rag_api.main:app --reload` với `PYTHONPATH=apps/api/src:...` |
| `make dev-web` | `npm run dev` trong `apps/web` |
| `make check` | compileall Python + `tsc --noEmit` + `npm run lint` |
| `make smoke` | TestClient gọi `/health` |
| `make rebuild` / `make rebuild-dry` | cập nhật corpus từ `.md` / chỉ xem diff |

Nếu không dùng Makefile:

```bash
PYTHONPATH=apps/api/src .venv/bin/uvicorn rag_api.main:app --port 8000
cd apps/web && npm run dev
```

---

## 7. Thêm tính năng mới ở đâu?

| Việc cần làm | Vị trí |
|---|---|
| Endpoint mới | `apps/api/src/rag_api/main.py` + module nghiệp vụ tương ứng |
| Quyền mới | `apps/api/src/rag_api/auth.py` → `PERMISSIONS`, rồi dùng `require_permission(...)` |
| Kho JSON-lines mới | `packages/backend/core/src/frm_core/store.py` + file trong `data/` |
| Luồng nghiệp vụ mới | module mới trong `apps/api/src/rag_api/`, đăng ký route trong `main.py` |
| UI theo role | `apps/web/components/` + `apps/web/app/page.tsx` |
| Gọi API từ web | `apps/web/lib/api.ts` (thêm interface + hàm authedFetch) |
| Thay đổi rule tag | `scripts/gan_tag.py` → `RULES`, rồi `make rebuild-dry` |
| Tài liệu | `README.md` (tính năng), `SETUP.md` (chạy), `apps/*/SETUP.md`, `docs/setup.md` |

---

## 8. Đối chiếu với frm-stack

| frm-stack | Dự án này | Ghi chú |
|---|---|---|
| `apps/backend/api`, `apps/frontend/web` | `apps/api`, `apps/web` | Đổi tên cho ngắn gọn, vẫn là app chạy được |
| `packages/backend/core` (DB/config/auth helpers) | `packages/backend/core/src/frm_core` (paths + JsonlStore) | Chưa có DB; lớp lưu là JSON-lines |
| `packages/shared/*` | chưa có | Dự phòng khi cần chia sẻ contract types giữa web và script |
| `db/schema.sql` + Atlas migrations | `data/` + `scripts/rebuild.py` | Nguồn sự thật là `.md` + JSON-lines, không phải SQL |
| `turbo.json` + `pnpm dev` | `Makefile` | Đủ cho 2 app, không cần pnpm workspace |
| `docs/*.md` | `docs/setup.md` + các `SETUP.md` | Tài liệu ngắn, mục lục ở root |

---

## 9. Lưu ý

- Mọi thay đổi hiện tại vẫn **chưa commit**; file `frm-stack/` và
  `data/nghiep_vu.docx` là artifact untracked, giữ nguyên.
- `apps/web/AGENTS.md` được `next dev` tạo lại tự động — không xoá.
- Runtime data (`users.json`, `.rebuild_secret`, `data/*.json`) tự tạo và đã
  ignore git; xoá để reset thì backend tự seed lại.
