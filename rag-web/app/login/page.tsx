"use client";

// app/login/page.tsx — Đăng nhập: Admin (tài khoản) hoặc Khách (1 nút)

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, guestLogin, login, setSession } from "@/lib/api";

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
        setSession({ token: r.token, role: r.role, display: r.display ?? r.role });
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
        setSession({ token: r.token, role: "guest", display: "Khách" });
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
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="text-5xl">🎓</div>
          <h1 className="mt-3 text-xl font-bold text-emerald-400">
            UTC Sổ tay Sinh viên K64
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Hỏi đáp RAG · Ollama local · 23 hashtag
          </p>
        </div>

        {/* Form admin */}
        <form
          onSubmit={doLogin}
          className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5"
        >
          <h2 className="text-sm font-semibold text-zinc-300">
            🛡 Đăng nhập Admin
          </h2>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Tài khoản"
            autoComplete="username"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-emerald-600"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mật khẩu"
            autoComplete="current-password"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-emerald-600"
          />
          <button
            type="submit"
            disabled={busy !== null || !username.trim() || !password}
            className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy === "admin" ? "⏳ Đang đăng nhập..." : "Đăng nhập"}
          </button>
        </form>

        <div className="flex items-center gap-3 text-xs text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          hoặc
          <span className="h-px flex-1 bg-zinc-800" />
        </div>

        {/* Vào khách */}
        <button
          onClick={doGuest}
          disabled={busy !== null}
          className="w-full rounded-2xl border border-zinc-700 bg-zinc-900/50 py-3 text-sm text-zinc-300 transition hover:border-emerald-700 hover:text-emerald-300 disabled:opacity-40"
        >
          👤 Vào với tư cách Khách
          <span className="mt-0.5 block text-[11px] text-zinc-500">
            chỉ chat — không chỉnh tham số / tag
          </span>
        </button>

        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-center text-xs text-red-400">
            ⚠ {error}
          </p>
        )}

        <p className="text-center text-[11px] text-zinc-600">
          Admin: chỉnh tham số RAG · gán tag đoạn · sửa định nghĩa hashtag
        </p>
      </div>
    </div>
  );
}
