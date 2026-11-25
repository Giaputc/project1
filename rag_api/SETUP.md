# SETUP — `rag_api/` (FastAPI backend)

Backend wrap pipeline RAG (`demo_ollama.py`) thành HTTP API: chat SSE, lịch sử,
hàng chờ, thông báo, rà soát/phê duyệt, đề xuất tài liệu, quản trị & báo cáo.
Không dùng database — toàn bộ trạng thái là JSON/JSONL trong `data/`.

Xem [SETUP.md ở root](../SETUP.md) để chạy cả hệ thống và [README.md](../README.md)
để biết kiến trúc/API tổng quát.

## 1. Chạy

```bash
cd /home/phamvangiap/Projects/project1

# Dev (auto reload khi sửa code)
.venv/bin/uvicorn rag_api.main:app --reload --port 8000

# Hoặc chạy thường
.venv/bin/uvicorn rag_api.main:app --port 8000
```

- Swagger UI: <http://localhost:8000/docs>; OpenAPI: <http://localhost:8000/openapi.json>.
- Health: `curl localhost:8000/health` → cần `ollama.ok: true`, `corpus.loaded: true`.
- CORS chỉ cho phép `http://localhost:3000` và `http://127.0.0.1:3000`
  (sửa `CORSMiddleware` trong `main.py` nếu dùng origin khác).
- Ollama được gọi cố định tại `http://localhost:11434` (hằng `OLLAMA` trong `main.py`).

Nếu thiếu thư viện:

```bash
python3 -m venv .venv
.venv/bin/pip install fastapi uvicorn httpx numpy rank-bm25 pydantic python-multipart pytest
```

## 2. Cấu hình & dữ liệu

| Biến / file | Mặc định | Ý nghĩa |
|---|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin123` | Chỉ áp dụng khi `rag_api/users.json` **chưa tồn tại** |
| `CANBO_USERNAME` / `CANBO_PASSWORD` | `canbo` / `canbo123` | Tạo mới khi `users.json` chưa có user `can_bo` |
| `rag_api/users.json` | tự tạo | Tài khoản + salt + hash SHA-256. Sửa qua API admin hoặc xoá file để seed lại |
| `rag_api/.rebuild_secret` | tự tạo | Secret nội bộ để `rebuild.py` gọi `/api/corpus/reload` không cần token |
| `data/corpus/` | có sẵn | `chunks_tagged.jsonl`, `tags.json`, `cache/` (embed) |
| `data/corpus/tags_manual.json` | tự tạo | Tag gán tay, ghi đè tag rule, không bị `rebuild.py` xoá |

Kho nghiệp vụ (tự tạo khi có ghi đầu tiên):

| Luồng | File | Module |
|---|---|---|
| D1 Lịch sử phiên | `data/lich_su.json` | `history.py` |
| D2 Corpus + tri thức đã duyệt | `data/corpus/`, `data/corpus/cache/bosung_embeds_*.json` | `rag_engine.py` |
| D3 Hàng chờ / tài liệu đề xuất | `data/hang_cho.json`, `data/tri_thuc.jsonl` | `hangcho.py`, `knowledge.py` |
| D4 Đánh giá / rà soát | `data/danh_gia.json`, `data/ra_soat.jsonl` | `feedback.py`, `reviews.py` |
| D5 Thông báo / người dùng | `data/thong_bao.jsonl`, `rag_api/users.json` | `notifications.py`, `auth.py` |
| D6 Chủ đề / phòng ban | `data/chu_de.jsonl` | `catalog.py`, `reports.py` |

## 3. Token & phân quyền

```bash
# Đăng nhập
curl -s -X POST localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
# → {"ok":true,"token":"...","username":"admin","role":"admin","display":"Admin"}

# Khách (không cần mật khẩu) — nên gửi guest_id riêng của từng client
curl -s -X POST localhost:8000/api/auth/guest \
  -H 'Content-Type: application/json' \
  -d '{"guest_id":"browser-A"}'
# → {"ok":true,"token":"...","username":"khach_browser-A","role":"guest","display":"Khách"}
```

- `POST /api/auth/guest` nhận `guest_id` tuỳ chọn (`[A-Za-z0-9_-]{1,64}`).
  Không gửi → server tự sinh id ngẫu nhiên. username guest dạng `khach_<id>`
  nên **lịch sử (`D1`) và thông báo (`D5`) của từng client không lẫn nhau**.
  Dữ liệu guest cũ lưu dưới username `khach` không tự migrate; có thể xoá khỏi
  `data/lich_su.json` / `data/thong_bao.jsonl` nếu không cần.
- Token lưu trong RAM server, hạn **24h**; gửi qua header `Authorization: Bearer <token>`.
- Restart backend → token cũ mất hiệu lực (phải đăng nhập lại). Đổi role/password
  trong admin cũng làm token cũ hết hạn.
- Ma trận `auth.PERMISSIONS`:

| Quyền (`perm`) | admin | can_bo | sinh_vien | guest |
|---|:---:|:---:|:---:|:---:|
| `chat_params` (gửi `params`) | ✅ | ❌ | ❌ | ❌ |
| `manage_tags` | ✅ | ❌ | ❌ | ❌ |
| `staff_queue` | ✅ | ✅ | ❌ | ❌ |
| `propose_doc` | ✅ | ✅ | ❌ | ❌ |
| `approve_doc` | ✅ | ❌ | ❌ | ❌ |
| `review_answer` | ✅ | ✅ | ❌ | ❌ |
| `approve_answer` | ✅ | ❌ | ❌ | ❌ |
| `manage_users` / `manage_topics` / `view_reports` / `rebuild` | ✅ | (chỉ `view_reports`) | ❌ | ❌ |

Chi tiết: admin có mọi quyền; cán bộ có `staff_queue`, `propose_doc`,
`review_answer`, `view_reports`; sinh viên/guest không có quyền quản trị.
`force_tag` (chọn hashtag khi câu hỏi mơ hồ) vẫn dùng được cho mọi role.

## 4. Endpoint theo quyền

| Quyền | Endpoint |
|---|---|
| Public | `GET /health`, `POST /api/auth/login`, `POST /api/auth/guest`, `POST /api/corpus/load` |
| Admin hoặc `X-Build-Secret` | `POST /api/corpus/reload` |
| Mọi role (có/không token) | `POST /api/ask`, `POST /api/ask/stream`, `POST /api/feedback` |
| Đã đăng nhập | `POST /api/history`, `GET /api/history/sessions`, `GET/DELETE /api/history/{sid}`, `POST /api/hangcho`, `GET /api/notifications`, `POST /api/notifications/read-all`, `POST /api/notifications/{id}/read` |
| Cán bộ/admin | `GET /api/hangcho`, `POST /api/hangcho/{id}/reply`, `POST/GET /api/knowledge`, `GET/POST /api/reviews`, `POST /api/reviews/{id}/review`, `GET /api/admin/reports?days=7` |
| Admin | `POST /api/knowledge/{id}/review`, `POST /api/reviews/{id}/decide`, `GET /api/feedback/stats`, `POST /api/preheat`, `POST /api/admin/rebuild`, `GET/POST/PUT/DELETE /api/admin/tags`, `GET /api/admin/chunks`, `PUT/DELETE /api/admin/chunks/{id}/tags`, `GET/POST/PUT/DELETE /api/admin/users`, `GET/POST/PUT/DELETE /api/admin/topics` |

### Ví dụ curl nhanh

```bash
# Biến token admin (chạy từ root project)
TOKEN=$(curl -s -X POST localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# Hỏi (SSE): meta → token* → done
curl -N -X POST localhost:8000/api/ask/stream \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"question":"Điều kiện xét học bổng là gì?"}'

# Chuyển câu hỏi cho cán bộ (từ tài khoản đã login; ở đây dùng admin)
curl -s -X POST localhost:8000/api/hangcho \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"question":"Câu hỏi ngoài sổ tay","reason":"Khách hỏi tay"}'

# Xem hàng chờ & trả lời (thay ITEM_ID bằng id trả về)
curl -s localhost:8000/api/hangcho -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8000/api/hangcho/ITEM_ID/reply \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"reply":"Cán bộ tư vấn trả lời tại đây."}'

# Đề xuất tài liệu (cán bộ/admin) rồi admin duyệt
DOC=$(curl -s -X POST localhost:8000/api/knowledge \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Quy định mới","text":"Nội dung quy định...","tag":"hoc-bong"}')
echo "$DOC"
# curl -s -X POST localhost:8000/api/knowledge/<entry_id>/review \
#   -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
#   -d '{"action":"duyet"}'   # tự embed + reload corpus

# Báo cáo 7 ngày
curl -s 'localhost:8000/api/admin/reports?days=7' -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Body chi tiết của từng endpoint xem trong Swagger `/docs` (hoặc bảng API trong
[README.md](../README.md)). `/api/ask/stream` phát các event: `meta` → `token`*
→ `done`; khi LLM lỗi/quá thời gian phát `error`.

## 5. Reload / rebuild corpus

- `POST /api/corpus/load`: nạp corpus **blocking** (dùng khi `/health` báo `loading`).
- `POST /api/corpus/reload`: đọc lại `chunks_tagged.jsonl` + cache embed từ disk;
  cần token admin hoặc header `X-Build-Secret` (file `rag_api/.rebuild_secret`).
- `POST /api/admin/rebuild`: chạy `rebuild.py` từ `.md` (md → chunk → tag →
  embed chunk đổi → reload). Mất vài giây đến ~1 phút; chỉ 1 rebuild chạy cùng lúc.
- Khi admin duyệt tài liệu/đáp án, backend tự gọi `reload_corpus()` — không cần
 restart. Tri thức bổ sung nằm ở cache `bosung_embeds`, **không ghi đè**
 `chunks.jsonl`.
- Nếu sửa `RULES` trong `gan_tag.py` hoặc normalize lại chunk, chạy
  `.venv/bin/python rebuild.py --dry-run` trước để xem diff.

## 6. Kiểm tra & lỗi thường gặp

```bash
cd /home/phamvangiap/Projects/project1
.venv/bin/python -m compileall -q rag_api
.venv/bin/python - <<'PY'
from fastapi.testclient import TestClient
from rag_api.main import app
c = TestClient(app)
r = c.get('/health')
print(r.status_code, r.json()['ollama']['ok'], r.json()['corpus']['loaded'])
PY
```

| Triệu chứng | Nguyên nhân | Xử lý |
|---|---|---|
| `401 Unauthorized` | Thiếu/expired token (24h hoặc vừa restart) | Đăng nhập lại, gửi `Authorization: Bearer ...` |
| `403 Forbidden` | Sai role | Dùng `admin` cho endpoint admin; `canbo` cho endpoint cán bộ |
| `403` trên `/api/corpus/reload` | Gọi từ script local không có token | Gửi header `X-Build-Secret` lấy từ `rag_api/.rebuild_secret` |
| `422 Unprocessable Entity` | Sai body (vd `vote` không phải `up/down`, `action` sai) | Xem schema tại `/docs` |
| `corpus đang nạp...` | Embed lần đầu / vừa reload | Đợi rồi gọi `POST /api/corpus/load` hoặc reload `/health` |
| `Ollama offline` | Ollama chưa chạy/sai model | `ollama serve`, `ollama pull qwen2.5:3b-instruct`, `ollama pull batiai/qwen3-embedding:0.6b-q8` |
| Câu hỏi tự vào hàng chờ | `OUT_OF_SCOPE`, không có nguồn, hoặc LLM lỗi/quá thời gian | Đây là thiết kế; `ASK_BACK` thì **không** tự chuyển |
| Không thấy thông báo | User khác với user lúc tạo hàng chờ | Guest giữ nguyên `guest_id` (localStorage `rag_guest_id`); đổi id = coi như khách mới |
