# SETUP — `rag-web/` (Next.js frontend)

Giao diện chat streaming + panel quản trị cho backend `rag_api`.
Xem [SETUP.md ở root](../SETUP.md) để chạy cả hệ thống và
[README.md](../README.md) để biết danh sách API.

## 1. Yêu cầu & cài đặt

- Node.js **20.9+** (theo yêu cầu của Next.js 16.4.3), npm đi kèm Node.
- Backend `rag_api` đang chạy ở `http://localhost:8000` (xem
  [`rag_api/SETUP.md`](../rag_api/SETUP.md)).
- Repo này đã có `node_modules/`; nếu cài lại:

```bash
cd /home/phamvangiap/Projects/project1/rag-web
npm install
```

## 2. Chạy

```bash
cd /home/phamvangiap/Projects/project1/rag-web

npm run dev     # development → http://localhost:3000
npm run build   # production build
npm run start   # chạy bản build (sau npm run build), cổng 3000
npm run lint    # eslint
npx tsc --noEmit # kiểm tra TypeScript (không tạo file)
```

Mở <http://localhost:3000>. Trang sẽ tự chuyển tới `/login` nếu chưa có phiên.

### Biến môi trường

Backend mặc định là `http://localhost:8000` (`lib/api.ts`). Nếu backend ở host/cổng khác:

```bash
# .env.local trong rag-web/
NEXT_PUBLIC_API_URL=http://192.168.1.10:8000
```

Lưu ý theo tài liệu Next.js: biến `NEXT_PUBLIC_*` được **inline lúc build**,
nên phải set trước `npm run build`; đổi value lúc runtime sẽ không có tác dụng
với bundle đã build. Với `npm run dev`, khởi động lại dev server sau khi sửa `.env.local`.

Nếu frontend chạy origin khác `localhost:3000`, phải thêm origin đó vào
`CORSMiddleware` trong `rag_api/main.py`.

## 3. Cấu trúc chính

| File | Vai trò |
|---|---|
| `app/page.tsx` | Trang chat, sidebar theo role, header, wiring panel |
| `app/login/page.tsx` | Đăng nhập tài khoản hoặc vào nhanh với tư cách Khách |
| `app/layout.tsx`, `app/globals.css` | Layout + theme Tailwind |
| `lib/api.ts` | Client gọi FastAPI, parse SSE, quản lý session `rag_session` |
| `components/ChatMessage.tsx` | Hiển thị câu trả lời, nguồn `[T1]`, chip hashtag, nút “Chuyển cán bộ” |
| `components/FeedbackBar.tsx` | 👍/👎 + sao + nhận xét |
| `components/ParamsPanel.tsx` | Tham số RAG (admin), preheat, reload, xoá chat |
| `components/TagManager.tsx`, `TagEditor.tsx` | Quản lý định nghĩa hashtag / gán tag tay |
| `components/HangChoPanel.tsx` | Hàng chờ câu hỏi + trả lời (cán bộ/admin) |
| `components/KnowledgePanel.tsx` | Đề xuất tài liệu, rà soát & phê duyệt đáp án |
| `components/AdminPanel.tsx` | 3 tab: 👥 Người dùng · 🏷 Chủ đề/Phòng ban · 📊 Báo cáo |
| `components/NotificationBell.tsx` | Chuông thông báo 🔔 (poll mỗi 15s) |
| `components/FeedbackStats.tsx` | Thống kê đánh giá (admin) |

Frontend là client-heavy: hầu hết component dùng `"use client"`, đọc
`localStorage` trong `getSession()` (có guard `typeof window === "undefined"`)
để tránh lỗi prerender.

## 4. Đăng nhập & giao diện theo vai trò

| Vai trò | Cách vào | Sidebar/UI |
|---|---|---|
| Khách / Sinh viên | Nút “👤 Vào với tư cách Khách” ở `/login`, hoặc tài khoản do admin tạo | Chat, lịch sử, đánh giá, chip tag, nút chuyển cán bộ, chuông 🔔 |
| Cán bộ tư vấn | `canbo` / `canbo123` | Thêm **Hàng chờ câu hỏi** (có badge số chờ), **Tri thức & phê duyệt** |
| Quản trị viên | `admin` / `admin123` | Mọi panel: tham số RAG, quản lý hashtag, người dùng/chủ đề, báo cáo, thống kê đánh giá |

Chi tiết panel **Tri thức & phê duyệt** (`KnowledgePanel.tsx`) có 2 tab:

- **📄 Tài liệu**: cán bộ/admin đề xuất; admin duyệt/từ chối → tự reload corpus.
- **⭐ Đáp án rà soát**: cán bộ vào “Chờ rà soát” → **Rà soát →** sửa/ghi chú →
  “Lưu rà soát”; admin vào “Chờ phê duyệt” → **Phê duyệt & đưa vào tri thức**.

Panel **Quản trị** (`AdminPanel.tsx`): tạo/sửa/xoá user, gán role, quản lý chủ đề
phòng ban, xem báo cáo D1/D4/D5. Panel **Báo cáo hệ thống** mở sẵn tab `📊 Báo cáo`.

Phiên đăng nhập lưu ở `localStorage["rag_session"]`, token hạn 24h, gửi qua
header `Authorization: Bearer <token>`. Đăng xuất hoặc hết hạn → quay lại `/login`.

**Tách phiên theo danh tính:** admin/cán bộ/sinh viên dùng `username` làm khóa;
khách dùng `khach_<guest_id>` với `guest_id` lưu riêng ở `localStorage["rag_guest_id"]`.
`localStorage["rag_chat_<username>"]` nhớ phiên chat đang mở của từng danh tính,
nên đăng xuất rồi vào tài khoản khác sẽ không thấy chat của tài khoản trước.
Lịch sử/thông báo trên server cũng tách theo `username` tương ứng.

## 5. Thử nhanh trên UI

1. Vào Khách → hỏi “Điều kiện xét học bổng là gì?” → thấy streaming, nguồn `[T1]`,
   badge quyết định; nếu mơ hồ sẽ hiện chip `#tag` để bấm chọn.
2. Chấm 👍 và ≥ 4 sao → đáp án vào hàng rà soát.
3. Đăng nhập `canbo` → **Tri thức & phê duyệt** → **⭐ Đáp án rà soát** →
   “Chờ rà soát” → rà soát & lưu.
4. Đăng nhập `admin` → cùng panel → “Chờ phê duyệt” → phê duyệt → hỏi lại câu đó
   để thấy nguồn `TL-...` mới.
5. Hỏi câu ngoài sổ tay → badge `✕ NGOÀI TÀI LIỆU` + tự động chuyển cán bộ.
   Đăng nhập cán bộ → **Hàng chờ câu hỏi** → trả lời → quay lại Khách xem 🔔.
6. Admin: **Người dùng & phân quyền** → tạo tài khoản `sinh_vien` để thử phân quyền;
   **Báo cáo hệ thống** → xem số liệu 7 ngày.

## 6. Lưu ý khi phát triển

- `app/page.tsx` poll `/health` mỗi **5s** để cập nhật trạng thái Ollama/corpus;
  `NotificationBell` poll `/api/notifications` mỗi **15s**.
- SSE được parse trong `lib/api.ts`; event theo thứ tự `meta` → `token`* →
  `done` (hoặc `error`). Nút **Dừng** ở header abort stream đang chạy.
- Nếu không gửi được `params` khi dùng cán bộ/khách: đây là thiết kế — server chỉ
  nhận `params` từ role `admin`; UI cũng ẩn panel tương ứng.
- `rag-web/AGENTS.md` được `next dev` tạo lại tự động; không xoá file này.
- `.next/` và `tsconfig.tsbuildinfo` là cache build, có thể xoá để build lại từ đầu.

## 7. Lỗi thường gặp

| Triệu chứng | Xử lý |
|---|---|
| `Không kết nối được localhost:8000` / chat báo lỗi mạng | Chạy backend; kiểm tra `NEXT_PUBLIC_API_URL`; kiểm tra CORS nếu đổi origin |
| Vào `/login` rồi bị quay lại `/login` liên tục | Token hết hạn hoặc backend vừa restart → đăng nhập lại |
| `Ollama ... · corpus đang nạp...` | Đợi embed cache lần đầu; admin bấm “🔄 Nạp lại corpus” nếu cần |
| Panel quản trị không hiện | Đang dùng phiên Khách/Cán bộ — đăng nhập `admin` |
| Chuông 🔔 không có thông báo | Guest đã đổi `rag_guest_id` (hoặc dùng browser khác) → username mới; kiểm tra `session.username` trong localStorage |
| `npm run build` in cảnh báo “known security vulnerability” | Next.js 16.4.3 có advisory; chạy lại lệnh để build tiếp. Nên nâng `next` + `eslint-config-next` (vd `npx next upgrade --agent=security`) trước khi deploy — repo này hiện chưa nâng |
| Lỗi TypeScript/Eslint sau khi sửa component | Chạy `npx tsc --noEmit` và `npm run lint` để biết vị trí cụ thể |
