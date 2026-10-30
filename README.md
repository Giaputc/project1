# Hỏi đáp Sổ tay sinh viên UTC — RAG Web (Next.js + FastAPI + Ollama)

Giao diện chat cho pipeline RAG N-tag trong `demo_ollama.py`
(23 tag · hybrid BM25+vector · Ollama local).

```
rag_api/   FastAPI  — wrapper pipeline demo_ollama, SSE streaming
rag-web/   Next.js  — UI chat + panel chỉnh tham số
```

## Điều kiện tiên quyết

- Ollama chạy tại `http://localhost:11434`, đã có model:
  - `qwen2.5:3b-instruct` (trả lời)
  - `batiai/qwen3-embedding:0.6b-q8` (embedding)
- Embed cache đã có sẵn tại `data/corpus/cache/` (nếu thiếu, lần chạy đầu sẽ
  embed lại — mất thời gian nhưng tự lưu cache).

## Chạy (2 terminal)

```bash
# 1) Backend — FastAPI :8000
.venv/bin/uvicorn rag_api.main:app --port 8000

# 2) Frontend — Next.js :3000
cd rag-web && npm run dev
```

Mở <http://localhost:3000>.

## Sửa dữ liệu trong `.md` → cập nhật hệ thống

Sửa thông tin trong `data/so_tay_sinh_vien_k64.md` rồi chạy **1 lệnh**:

```bash
.venv/bin/python rebuild.py            # rebuild + verify + reload backend
.venv/bin/python rebuild.py --dry-run  # chỉ xem diff, không ghi gì
```

`rebuild.py` tự động:

1. So md với 158 chunk cũ (substring match từng chunk) → chunk nào text y nguyên
   thì **giữ nguyên** (id, số trang, vector embed — không tốn embed lại).
2. Chunk nào text bị sửa → cắt lại theo heading + đoạn văn, **kế thừa id + số
   trang** từ chunk cũ; heading mới được parse lại (reset level sâu hơn đúng cách).
3. Ghi `chunks.jsonl` (tự backup `.bak.<timestamp>`) → chạy `gan_tag.py`
   verify 23 tag + golden_qa. **FAIL → tự rollback**, không cập nhật gì.
4. Embed lại **CHỈ các chunk đổi** (xóa vector cũ khỏi cache — hết bẫy
   "vector cũ, text mới").
5. Gọi `POST /api/corpus/reload` → web trả lời dữ liệu mới **ngay, không
   cần restart** (hoặc bấm nút "🔄 Nạp lại corpus" trên sidebar).

Lưu ý:

- Trang của chunk **mới thêm** (heading chưa từng có) là ước lượng (kế thừa
  trang chunk đứng trước) — md không mang số trang gốc.
- Nếu sửa **tiêu đề mục** → `gan_tag.py` verify sẽ FAIL (rule tag theo heading)
  → sửa `RULES` trong `gan_tag.py` rồi chạy lại.
- Chạy được cả khi backend đang tắt (bước 5 sẽ WARN, chạy lại sau cũng được).

## Đăng nhập & phân quyền

Mở `http://localhost:3000` → trang `/login`:

| | 👤 Khách | 🛡 Admin |
|---|---|---|
| Chat (streaming, nguồn, chip hashtag khi mơ hồ) | ✅ | ✅ |
| Gửi `params` chỉnh tham số | ❌ **bị server bỏ qua** (dùng default) | ✅ |
| Panel tham số (temperature, topk, tag_boost...) | ❌ ẩn | ✅ |
| ⚡ Preheat model | ❌ 403 | ✅ |
| 🔄 Nạp lại corpus (sau `rebuild.py`) | ❌ 403 | ✅ |
| 🏷 Gán tag tay từng chunk (trong khung Nguồn) | ❌ | ✅ |
| 🏷 Sửa định nghĩa tag (description / synonyms / câu ví dụ) | ❌ | ✅ |

- Tài khoản admin mặc định `admin` / `admin123` — seed ở `rag_api/users.json`
  (đổi bằng env `ADMIN_USERNAME` / `ADMIN_PASSWORD` khi file chưa tồn tại,
  hoặc sửa trực tiếp file).
- Khách bấm **"👤 Vào với tư cách Khách"** — không cần mật khẩu.
- Token lưu localStorage (`rag_session`), hạn 24h; header `Authorization: Bearer <token>`.
- An toàn **ở lớp server**: request guest không token → `params` bị bỏ qua
  bất kể client gửi gì; endpoint admin trả 401/403.

### Tag thủ công + định nghĩa tag (admin)

- **Gán tag chunk**: khung "Nguồn [T1]..." → nút 🏷 → tick/bỏ 23 tag → Lưu
  (hoặc "↺ Khôi phục tag rule"). Tag ghi vào `data/corpus/tags_manual.json`
  (`{chunk_id: [tags]}`) — **sống riêng, không bị `rebuild.py` xoá**, ghi đè
  tag rule, hiệu lực ngay cho retrieve.
- **Sửa định nghĩa tag**: sidebar admin → "🏷 Quản lý định nghĩa hashtag" —
  sửa `description` / `synonyms` / thêm **`examples` (câu ví dụ)**. Routing chấm
  `score(tag) = max(cos(q, mô tả+synonyms), max(cos(q, exemplar)))` — thêm
  exemplar là đòn bẩy mạnh nhất cho chính xác routing input. Lưu server tự
  re-embed + nạp lại corpus.
- Thêm tag mới / xoá tag được luôn (tag mới chưa có chunk nào mang → admin gán
  chunk tay; `rebuild.py` chỉ WARN nếu số tag lệch chuẩn rule).

## API

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET  | `/health` | public | trạng thái Ollama + corpus + default params |
| POST | `/api/auth/login` | public | `{username,password}` → `{token,role,display}` |
| POST | `/api/auth/guest` | public | phát token role `guest` |
| POST | `/api/ask` | all | hỏi — JSON đầy đủ (meta + answer + stats) |
| POST | `/api/ask/stream` | all | hỏi — SSE: `meta` → `token`* → `done` (hoặc `error`) |
| POST | `/api/preheat` | admin | nạp model vào RAM (~60s, chạy 1 lần) |
| POST | `/api/corpus/load` | public | ép nạp corpus (block) |
| POST | `/api/corpus/reload` | admin | nạp lại corpus + embed cache từ disk (sau `rebuild.py`) |
| GET | `/api/admin/tags` | admin | danh sách tag + số chunk (rule / hiện tại) |
| POST | `/api/admin/tags` | admin | thêm tag mới |
| PUT | `/api/admin/tags/{id}` | admin | sửa description / synonyms / examples |
| DELETE | `/api/admin/tags/{id}` | admin | xoá tag (gỡ khỏi tag tay các chunk) |
| GET | `/api/admin/chunks?q=` | admin | danh sách chunk + tag hiện tại |
| PUT | `/api/admin/chunks/{id}/tags` | admin | gán tag tay (`{"tags":[...]}`) |
| DELETE | `/api/admin/chunks/{id}/tags` | admin | khôi phục tag rule |

Body của `/api/ask` và `/api/ask/stream`:

```jsonc
{
  "question": "Điều kiện học bổng là gì?",
  "params": { "use_llm": true, "topk": 1 },   // optional, xem DEFAULT_PARAMS
  "force_tag": "hoc-bong"                     // optional — tag user chọn thủ công
}
```

Ví dụ:

```bash
curl -N -X POST localhost:8000/api/ask/stream \
  -H 'Content-Type: application/json' \
  -d '{"question":"Điều kiện xét học bổng là gì?"}'
```

## UI

- **`/login`**: đăng nhập admin (tài khoản/mật khẩu) hoặc vào nhanh bằng 1 nút
  "👤 Khách".
- **Cột trái (admin)**: panel tham số — model Ollama, preheat, toggle gọi LLM,
  temperature / max_tokens / topk / rrf_k / tag_boost / margin_ask / score_low,
  trạng thái Ollama + corpus, nạp lại corpus, xoá lịch sử, nút **"🏷 Quản lý
  định nghĩa hashtag"**.
- **Cột trái (khách)**: chỉ trạng thái hệ thống + xoá lịch sử (không tham số).
- **Chat**: trả lời streaming từng token, badge quyết định
  (`ANSWER` / `ASK_BACK` / `OUT_OF_SCOPE`), **chip hashtag bấm được khi mơ hồ**
  (bấm tag → tự gửi lại cùng câu hỏi với `force_tag`, trả lời strict theo tag
  đã chọn, hiện badge "CHỌN THỦ CÔNG"), collapsible **Nguồn [T1]...**
  (chunk id, trang, tag, heading, text gốc — admin có nút 🏷 gán tag từng chunk),
  timing (prompt/sinh token, cảnh báo cold start / chạm trần max_tokens),
  câu hỏi gợi ý, nút Dừng giữa chừng.
- Header: tên hiển thị + badge vai trò + **Đăng xuất**.

### Chọn tag khi câu hỏi mơ hồ (trước khi LLM trả lời)

Khi `margin < margin_ask` → backend trả `ASK_BACK` và **DỪNG trước LLM**
(`meta` + `done.skipped_llm=true`, không sinh token) → FE hiện 3 chip `#tag`
bấm được, trạng thái "chờ bạn chọn hashtag":

1. Bấm chip → gửi lại **cùng câu hỏi** với `force_tag=<tag>`.
2. Backend bypass ngưỡng, `decision=ANSWER`, retrieve **strict scope**
   (chỉ chunk mang tag đó, xếp hạng RRF) → giờ mới gọi LLM stream trả lời.
3. `meta.forced_tag` + `strict_scope=true`; tag không hợp lệ → SSE `error`.

## Ghi chú kỹ thuật

- `rag_api/rag_engine.py` **import pipeline từ `demo_ollama.py`** — không copy
  logic; globals (`CHAT_MODEL`, `TOPK`, `MARGIN_ASK`...) được set theo request
  dưới 1 lock tuần tự.
- `OUT_OF_SCOPE` → không gọi LLM (trả meta + lý do). `ASK_BACK` → **dừng chờ
  user chọn hashtag** (LLM chưa chạy), trả lời sau khi có `force_tag`
  (đúng hành vi "hỏi lại" — không tự chọn tag ngầm).
- CORS cho `localhost:3000`. Đổi backend bằng env
  `NEXT_PUBLIC_API_URL=http://host:port`.
