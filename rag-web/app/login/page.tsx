"use client";

// app/login/page.tsx — Đăng nhập: Admin (tài khoản) hoặc Khách (1 nút)

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, guestLogin, login, setSession } from "@/lib/api";

const INPUT_CLS =
  "w-full rounded-control border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none transition focus-visible:border-ring focus-visible:ring-3 motion-reduce:transition-none";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"admin" | "guest" | null>(null);

  // đã đăng nhập rồi → về /chat (trang chính)
  useEffect(() => {
    if (getSession()) router.replace("/");
  }, [router]);

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy("admin");
    try {
      const r = await login(username.trim(), password);
      if (r.ok && r.token && r.role) {
        setSession({
          token: r.token,
          username: r.username ?? username.trim(),
          role: r.role,
          display: r.display ?? r.role,
        });
        router.replace("/");
      } else {
        setError(r.error ?? "Đăng nhập thất bại");
      }
    } catch (e2) {
      setError(`Không kết nối được backend (${String(e2)})`);
    } finally {
      setBusy(null);
    }
  };

  const doGuest = async () => {
    setError(null);
    setBusy("guest");
    try {
      const r = await guestLogin();
      if (r.ok && r.token) {
        setSession({
          token: r.token,
          username: r.username ?? "khach",
          role: "guest",
          display: "Khách",
        });
        router.replace("/");
      } else {
        setError("Không vào được chế độ Khách");
      }
    } catch (e2) {
      setError(`Không kết nối được backend (${String(e2)})`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="surface-atmosphere flex min-h-screen items-center justify-center px-4 py-12 text-foreground">
      <div className="w-full max-w-sm enter-rise">
        <header className="mb-6 text-center enter-fade">
          <span
            aria-hidden
            className="inline-flex size-10 items-center justify-center rounded-control border border-border bg-card text-lg"
          >
            🎓
          </span>
          <p className="mt-4 font-mono text-[11px] tracking-[0.18em] text-muted-foreground uppercase">
            Đại học Giao thông Vận tải
          </p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">
            Sổ tay Sinh viên K64
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Hỏi đáp RAG · Ollama local · 23 hashtag
          </p>
        </header>

        {/* Form admin */}
        <form
          onSubmit={doLogin}
          className="space-y-3 rounded border border-border bg-card p-5 enter-rise"
          style={{ animationDelay: "80ms" }}
        >
          <h2 className="text-xs font-medium text-muted-foreground/70">
            Đăng nhập tài khoản
          </h2>
          <div className="space-y-2">
            <label htmlFor="username" className="sr-only">
              Tài khoản
            </label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Tài khoản"
              autoComplete="username"
              className={INPUT_CLS}
            />
            <label htmlFor="password" className="sr-only">
              Mật khẩu
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mật khẩu"
              autoComplete="current-password"
              className={INPUT_CLS}
            />
          </div>
          <button
            type="submit"
            disabled={busy !== null || !username.trim() || !password}
            className="w-full rounded-control bg-brand py-2.5 text-sm font-medium text-brand-foreground transition hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-40 motion-reduce:transition-none"
          >
            {busy === "admin" ? "⏳ Đang đăng nhập..." : "Đăng nhập"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground/70">
          <span className="h-px flex-1 bg-border" />
          hoặc
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* Vào khách */}
        <button
          onClick={doGuest}
          disabled={busy !== null}
          className="w-full rounded border border-border bg-card/60 px-4 py-3 text-sm transition hover:border-brand-border hover:bg-card focus-visible:ring-3 disabled:opacity-40 enter-rise motion-reduce:transition-none"
          style={{ animationDelay: "160ms" }}
        >
          <span className="flex items-center justify-center gap-2 font-medium">
            <span aria-hidden>👤</span> Vào với tư cách Khách
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            chỉ chat — không chỉnh tham số / tag
          </span>
        </button>

        {error && (
          <p className="mt-4 rounded-control border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
            ⚠ {error}
          </p>
        )}

        <p className="mt-5 text-center text-[11px] leading-relaxed text-muted-foreground/70">
          Admin <span className="font-mono">admin/admin123</span>: chỉnh tham số ·
          phê duyệt · quản trị · báo cáo · Cán bộ{" "}
          <span className="font-mono">canbo/canbo123</span>: trả lời hàng chờ,
          đề xuất tài liệu, rà soát đáp án
        </p>
      </div>
    </div>
  );
}
