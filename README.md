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
- **Phiên chat tách riêng theo danh tính**: admin/cán bộ/sinh viên dùng `username`;
  khách dùng `khach_<guest_id>` (`guest_id` lưu ở `localStorage.rag_guest_id`).
  `localStorage.rag_chat_<username>` nhớ phiên đang mở của từng người, nên đổi
  tài khoản không thấy chat của người trước. Lịch sử D1 & thông báo D5 cũng lọc theo
  `username` tương ứng.
- Token lưu localStorage (`rag_session`), hạn 24h; header `Authorization: Bearer <token>`.
  Session cũ không có `username` sẽ bị yêu cầu đăng nhập lại.
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

## Luồng nghiệp vụ theo `data/nghiep_vu.docx`

Các luồng đã phủ (JSON-lines trong `data/`, không cần DB 13 bảng):

| Nghiệp vụ | Kho | Nơi triển khai |
|---|---|---|
| 1.0 Tiếp nhận & phân loại câu hỏi, lịch sử phiên | D1 `data/lich_su.json` | `rag_api/history.py` |
| 2.0 Truy xuất RAG + sinh trả lời | D2 `data/corpus/` | `rag_api/rag_engine.py` |
| 3.0 Hàng chờ cán bộ (tự động khi `OUT_OF_SCOPE` / hết ngữ cảnh / LLM lỗi, hoặc sinh viên bấm tay) | D3 `data/hang_cho.json` | `rag_api/hangcho.py`, hook trong `main.py` |
| 3.0 Thông báo cho sinh viên / cán bộ | D5 `data/thong_bao.jsonl` | `rag_api/notifications.py`, chuông 🔔 trên header |
| 4.0 Đánh giá → cán bộ rà soát → admin phê duyệt → ngược vào tri thức | D4 `data/danh_gia.json`, `data/ra_soat.jsonl` | `rag_api/feedback.py`, `rag_api/reviews.py` |
| 5.0 Cán bộ đề xuất tài liệu → admin duyệt → embed + index | D3 `data/tri_thuc.jsonl` → D2 | `rag_api/knowledge.py`, `_inject_approved()` |
| 6.0 Quản lý người dùng/phân quyền, chủ đề/phòng ban, báo cáo | D5/D6 `data/chu_de.jsonl` | `rag_api/auth.py`, `catalog.py`, `reports.py` |

Chi tiết:

- **Chuyển cán bộ tự động**: ngay khi event `meta` báo `OUT_OF_SCOPE` (hoặc không có
  nguồn) / event `error` (LLM lỗi, quá thời gian), backend tạo 1 item hàng chờ, gắn
  `meta.handoff` vào SSE và gửi thông báo cho cán bộ. Cùng câu hỏi trong 10 phút
  không tạo trùng. Sinh viên vẫn có nút "⟶ Chuyển câu hỏi cho cán bộ" trong khung
  trả lời. `ASK_BACK` không tự chuyển (chờ user chọn hashtag).
- **Học từ phản hồi**: đánh giá `↑` + ≥ 4 sao → tự động vào hàng rà soát; cán bộ
  đọc/sửa đáp án, admin phê duyệt → chunk `TL-...` được embed (cache
  `bosung_embeds`) và nạp vào D2. Không ghi đè `chunks.jsonl` của `rebuild.py`.
- **Tài liệu đề xuất**: cán bộ nhập tiêu đề/nội dung/chủ đề → admin duyệt → tự
  `reload_corpus()` để tài liệu có hiệu lực ngay. Có thể bấm "↻ Nạp lại corpus"
  trong panel nếu cần.
- **Phân quyền**: ma trận `auth.PERMISSIONS` — admin (mọi quyền), cán bộ
  (hàng chờ, đề xuất & rà soát, xem báo cáo), sinh viên/guest (chat, đánh giá,
  lịch sử, thông báo). Đổi role/mật khẩu trong admin → token cũ hết hạn.
- **Báo cáo**: `/api/admin/reports?days=7` gom D1 (tin nhắn, phiên, quyết định
  router, câu hỏi phổ biến), D4 (điểm, theo tag), D3 (hàng chờ, cán bộ trả lời),
  D5 (số người dùng), D6 (chủ đề).

Tài khoản mẫu: `admin/admin123` (quản trị), `canbo/canbo123` (cán bộ tư vấn).
Có thể tạo sinh viên trong tab "Người dùng & phân quyền".

## API

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET  | `/health` | public | trạng thái Ollama + corpus + default params |
| POST | `/api/auth/login` | public | `{username,password}` → `{token,username,role,display}` |
| POST | `/api/auth/guest` | public | phát token `guest`; body tuỳ chọn `{"guest_id":"..."}` → username `khach_<id>` riêng từng client |
| POST | `/api/ask` | all | hỏi — JSON đầy đủ (meta + answer + stats) |
| POST | `/api/ask/stream` | all | hỏi — SSE: `meta` → `token`* → `done` (hoặc `error`) |
| POST | `/api/preheat` | admin | nạp model vào RAM (~60s, chạy 1 lần) |
| POST | `/api/corpus/load` | public | ép nạp corpus (block) |
| POST | `/api/corpus/reload` | admin | nạp lại corpus + embed cache từ disk (sau `rebuild.py`) |
| POST | `/api/feedback` | all | đánh giá ↑↓ + sao + nhận xét (≥4 sao → hàng rà soát) |
| GET | `/api/feedback/stats` | admin | thống kê đánh giá |
| POST | `/api/history` · GET/DELETE `/api/history/{sid}` | login | lịch sử phiên chat (D1) |
| GET | `/api/history/sessions` | login | danh sách phiên của chính mình |
| POST | `/api/hangcho` | login | chuyển câu hỏi cho cán bộ (D3) |
| GET | `/api/hangcho` · POST `/api/hangcho/{id}/reply` | cán bộ/admin | hàng chờ + trả lời (→ thông báo) |
| GET | `/api/notifications` · POST `/api/notifications/{id}/read` | login | thông báo (D5) |
| POST | `/api/knowledge` · GET `/api/knowledge` | cán bộ/admin | đề xuất & xem tài liệu tri thức |
| POST | `/api/knowledge/{id}/review` | admin | duyệt/từ chối → embed + index |
| GET | `/api/reviews` · POST `/api/reviews/{id}/review` | cán bộ/admin | rà soát đáp án |
| POST | `/api/reviews/{id}/decide` | admin | phê duyệt → đưa ngược vào tri thức |
| GET/POST/PUT/DELETE | `/api/admin/topics` | admin | chủ đề / phòng ban (D6) |
| GET/POST/PUT/DELETE | `/api/admin/users` | admin | người dùng & phân quyền (D5) |
| GET | `/api/admin/reports?days=` | cán bộ/admin | báo cáo tổng hợp (6.0) |
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
- **Cột trái (cán bộ)**: "Hàng chờ câu hỏi" (trả lời sinh viên),
  "Tri thức & phê duyệt" (đề xuất tài liệu, rà soát đáp án).
- **Cột trái (admin)**: thêm "Người dùng & phân quyền", "Báo cáo hệ thống".
- **Header**: chuông 🔔 thông báo (câu trả lời cán bộ, tài liệu duyệt, hàng chờ mới).
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
