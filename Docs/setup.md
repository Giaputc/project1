# setup.md — Chỉ dẫn nhanh

File này là mục lục. Hướng dẫn chi tiết nằm ở:

- [`../SETUP.md`](../SETUP.md) — cài đặt & chạy toàn hệ thống (Ollama + FastAPI + Next.js).
- [`../rag_api/SETUP.md`](../rag_api/SETUP.md) — backend: endpoint, phân quyền, curl, reload/rebuild.
- [`../rag-web/SETUP.md`](../rag-web/SETUP.md) — frontend: npm scripts, vai trò UI, xử lý lỗi build.

## Khởi động nhanh

```bash
# 1) Ollama (nếu chưa chạy)
ollama pull qwen2.5:3b-instruct
ollama pull batiai/qwen3-embedding:0.6b-q8
ollama serve

# 2) Backend — terminal 1
cd /home/phamvangiap/Projects/project1
.venv/bin/uvicorn rag_api.main:app --port 8000

# 3) Frontend — terminal 2
cd /home/phamvangiap/Projects/project1/rag-web
npm run dev
```

Mở <http://localhost:3000>. Kiểm tra backend: `curl localhost:8000/health`.

## Tài khoản mẫu

| Vai trò | Đăng nhập |
|---|---|
| Quản trị viên | `admin` / `admin123` |
| Cán bộ tư vấn | `canbo` / `canbo123` |
| Sinh viên/Khách | `sinhvien` / `sinhvien123` |

> Mỗi danh tính có phiên chat riêng: admin/cán bộ/sinh viên theo `username`,
> khách theo `khach_<guest_id>` (lưu trong `localStorage.rag_guest_id`).
> Đổi tài khoản không thấy chat của tài khoản trước.

## Việc làm được ngay

- Hỏi đáp Sổ tay K64 có trích nguồn, chip hashtag khi câu hỏi mơ hồ.
- Câu hỏi ngoài tài liệu / LLM lỗi → **tự chuyển cán bộ** + chuông 🔔 thông báo.
- Đánh giá 👍/👎 + sao → cán bộ rà soát → admin phê duyệt → đưa ngược vào tri thức.
- Cán bộ đề xuất tài liệu → admin duyệt → hiệu lực ngay (không restart).
- Admin quản lý user, chủ đề/phòng ban, hashtag, tham số RAG và xem báo cáo.

Cập nhật nội dung sổ tay: sửa `data/so_tay_sinh_vien_k64.md` rồi chạy
`.venv/bin/python rebuild.py` (xem chi tiết trong `../README.md`).
