# SETUP — Chatbot tư vấn sinh viên UTC (RAG)

Hướng dẫn chạy toàn bộ hệ thống: **FastAPI `:8000`** + **Next.js `:3000`** + **Ollama local**.
Chi tiết từng phần xem [`rag_api/SETUP.md`](rag_api/SETUP.md) và
[`rag-web/SETUP.md`](rag-web/SETUP.md). Kiến trúc & API đầy đủ ở [`README.md`](README.md).

## 1. Yêu cầu

| Thành phần | Yêu cầu |
|---|---|
| Ollama | chạy tại `http://localhost:11434` |
| Model trả lời | `qwen2.5:3b-instruct` |
| Model embedding | `batiai/qwen3-embedding:0.6b-q8` |
| Python | 3.11+ (đang dùng 3.14) — có sẵn `.venv` trong repo |
| Node | 20.9+ (Next.js 16.4.3, React 19) — có sẵn `rag-web/node_modules` |
| Cổng | `8000` (backend), `3000` (frontend) |

Nếu chưa có model:

```bash
ollama pull qwen2.5:3b-instruct
ollama pull batiai/qwen3-embedding:0.6b-q8
ollama serve          # nếu Ollama chưa chạy
```

## 2. Cài đặt lần đầu

Repo này đã có `.venv` và `rag-web/node_modules`. Nếu cần cài lại từ đầu:

```bash
cd /home/phamvangiap/Projects/project1

python3 -m venv .venv
.venv/bin/pip install fastapi uvicorn httpx numpy rank-bm25 pydantic python-multipart pytest

cd rag-web && npm install
```

Kiểm tra corpus (đã có sẵn trong repo):

```bash
ls data/corpus/chunks_tagged.jsonl data/corpus/tags.json data/corpus/cache/
```

Lần đầu chạy, backend embed các chunk/tag chưa có cache → chờ vài giây tới vài phút.
Cache nằm ở `data/corpus/cache/` và `data/corpus/cache/bosung_embeds_...json`.

## 3. Chạy (2 terminal)

```bash
# Terminal 1 — Backend
cd /home/phamvangiap/Projects/project1
.venv/bin/uvicorn rag_api.main:app --port 8000

# Terminal 2 — Frontend
cd /home/phamvangiap/Projects/project1/rag-web
npm run dev
```

Mở <http://localhost:3000>. Kiểm tra backend:

```bash
curl localhost:8000/health
# "ollama.ok" phải true, "corpus.loaded" phải true
```

## 4. Tài khoản & thử nhanh 3 vai trò

| Vai trò | Đăng nhập | Làm được gì |
|---|---|---|
| Khách / Sinh viên | nút “👤 Vào với tư cách Khách” (hoặc user do admin tạo) | Hỏi đáp, lịch sử, đánh giá, chuyển câu hỏi cho cán bộ, xem thông báo 🔔. Mỗi khách là `khach_<guest_id>` riêng, không dùng chung một phiên |
| Cán bộ tư vấn | `canbo` / `canbo123` | Hàng chờ, đề xuất tài liệu, rà soát đáp án, báo cáo |
| Quản trị viên | `admin` / `admin123` | Mọi quyền + tham số/tag, phê duyệt, quản trị user/chủ đề |

Demo luồng “học từ phản hồi” (5 phút):

1. Đăng nhập **Khách** → hỏi “Điều kiện xét học bổng là gì?” → xem nguồn `[T1]` + nhưng chip `#tag` nếu mơ hồ.
2. Bấm 👍 hoặc chấm ≥ 4 sao → đáp án vào hàng rà soát.
3. Đăng nhập `canbo` → sidebar **Tri thức & phê duyệt** → tab “⭐ Đáp án rà soát” → “Chờ rà soát” → **Rà soát →** sửa/ghi chú → **Lưu rà soát**.
4. Đăng nhập `admin` → cùng panel → tab “⭐ Đáp án rà soát” → bộ lọc “Chờ phê duyệt” → **Phê duyệt & đưa vào tri thức** (tự reload corpus).
5. Quay lại Khách, hỏi lại câu đó → nguồn có chunk `TL-...` mới.

Demo luồng “AI không đủ tin cậy”:

- Hỏi câu ngoài tài liệu (vd “Thời tiết Hà Nội hôm nay?”) → badge `✕ NGOÀI TÀI LIỆU` +
  `⟶ ĐÃ CHUYỂN CÁN BỘ`. Đăng nhập cán bộ → “Hàng chờ câu hỏi” → trả lời →
  sinh viên thấy 🔔 thông báo với nội dung trả lời.

## 5. Cập nhật dữ liệu

- **Sửa sổ tay**: sửa `data/so_tay_sinh_vien_k64.md` rồi
  `.venv/bin/python rebuild.py` (xem chi tiết trong `README.md`).
- **Thêm tài liệu nhanh**: UI admin/cán bộ → “Tri thức & phê duyệt” → đề xuất →
  admin duyệt → embed + index ngay, không cần sửa `.md`.
- **Nạp lại corpus**: admin bấm “🔄 Nạp lại corpus” hoặc `POST /api/corpus/reload`.

## 6. Lỗi thường gặp

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `Ollama offline`, health báo lỗi | Ollama chưa chạy / sai model | `ollama serve`, `ollama pull ...`, reload `/health` |
| `Corpus đang nạp...` | Lần đầu embed hoặc vừa reload | Đợi vài giây; không gửi câu hỏi lúc này |
| `HTTP 401` | Hết token (24h) hoặc đổi role/password | Đăng nhập lại |
| `HTTP 403` trên panel tham số | Khách/cán bộ gửi `params` | Chỉ admin được chỉnh tham số — server đã bỏ qua |
| `Không kết nối được backend :8000` | Backend chưa chạy / sai cổng | Chạy lệnh terminal 1; kiểm tra `NEXT_PUBLIC_API_URL` |
| `npm run build` dừng ở cảnh báo bảo mật | Next.js 16.4.3 có advisory | Chạy lại lệnh lần 2 để build tiếp; nên nâng cấp Next.js |
| Thông báo không hiện | Đổi `guest_id` hoặc dùng browser khác | Guest có username riêng `khach_<id>`; giữ nguyên browser/localStorage để xem lại thông báo |

## 7. Dữ liệu runtime (tự tạo, đã ignore git)

```
rag_api/users.json          # tài khoản + hash mật khẩu
data/lich_su.json           # D1 lịch sử phiên
data/hang_cho.json          # D3 hàng chờ
data/danh_gia.json          # D4 đánh giá
data/tri_thuc.jsonl         # D3 tài liệu/đáp án đã duyệt
data/ra_soat.jsonl          # D4 hàng rà soát đáp án
data/thong_bao.jsonl        # D5 thông báo
data/chu_de.jsonl           # D6 tuỳ chỉnh chủ đề/phòng ban
```

Xoá các file này để reset về trạng thái sạch (backend sẽ tự tạo lại khi cần).
