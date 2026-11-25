"use client";

// components/AdminPanel.tsx — Quản trị: người dùng/phân quyền, chủ đề/phòng ban,
// báo cáo tổng hợp (D5, D6, nghiệp vụ 6.0).

import { useCallback, useEffect, useState } from "react";
import {
  adminAddUser,
  adminDeleteTopic,
  adminDeleteUser,
  adminListTopics,
  adminListUsers,
  adminReports,
  adminSaveTopic,
  adminUpdateUser,
  type AdminUser,
  type ReportData,
  type RoleOption,
  type Topic,
} from "@/lib/api";

interface Props {
  onClose: () => void;
  initialTab?: Tab;
}

export type Tab = "users" | "topics" | "reports";

const INPUT =
  "w-full rounded-control border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3";
const BTN =
  "h-8 rounded-control border px-3 text-xs font-medium transition focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-40";

export default function AdminPanel({ onClose, initialTab = "users" }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // user form
  const [uName, setUName] = useState("");
  const [uPass, setUPass] = useState("");
  const [uRole, setURole] = useState<AdminUser["role"]>("sinh_vien");
  const [uDisplay, setUDisplay] = useState("");
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pwDraft, setPwDraft] = useState("");

  // topic form
  const [selected, setSelected] = useState<string | null>(null);
  const [tName, setTName] = useState("");
  const [tDesc, setTDesc] = useState("");
  const [tDept, setTDept] = useState("");
  const [filter, setFilter] = useState("");

  const loadUsers = useCallback(async () => {
    const r = await adminListUsers();
    setUsers(r.users);
    setRoles(r.roles);
  }, []);
  const loadTopics = useCallback(async () => { setTopics(await adminListTopics()); }, []);
  const loadReport = useCallback(async () => { setReport(await adminReports()); }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadUsers();
      void loadTopics();
      void loadReport();
    }, 0);
    return () => clearTimeout(t);
  }, [loadUsers, loadTopics, loadReport]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickTopic = (t: Topic) => {
    setSelected(t.id);
    setTName(t.name);
    setTDesc(t.description);
    setTDept(t.phong_ban);
    setMsg(null);
  };

  const addUser = async () => {
    if (!uName.trim() || !uPass) return;
    setBusy(true); setMsg(null);
    const r = await adminAddUser({
      username: uName.trim(), password: uPass, role: uRole,
      display: uDisplay.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) { setMsg({ text: r.error ?? "Không thêm được", ok: false }); return; }
    setUName(""); setUPass(""); setUDisplay("");
    setMsg({ text: "Đã thêm người dùng.", ok: true });
    void loadUsers();
  };

  const setRole = async (username: string, role: AdminUser["role"]) => {
    setBusy(true);
    const r = await adminUpdateUser(username, { role });
    setBusy(false);
    setMsg(r.ok ? { text: `Đã đổi quyền ${username} → ${role}`, ok: true }
                : { text: r.error ?? "Không đổi được quyền", ok: false });
    void loadUsers();
  };

  const savePassword = async (username: string) => {
    if (!pwDraft) return;
    setBusy(true);
    const r = await adminUpdateUser(username, { password: pwDraft });
    setBusy(false); setPwFor(null); setPwDraft("");
    setMsg(r.ok ? { text: "Đã đổi mật khẩu.", ok: true }
                : { text: r.error ?? "Không đổi được mật khẩu", ok: false });
  };

  const removeUser = async (username: string) => {
    setBusy(true);
    const r = await adminDeleteUser(username);
    setBusy(false);
    setMsg(r.ok ? { text: `Đã xoá ${username}`, ok: true }
                : { text: r.error ?? "Không xoá được", ok: false });
    void loadUsers();
  };

  const saveTopic = async () => {
    if (!tName.trim()) return;
    setBusy(true);
    const r = await adminSaveTopic({
      id: selected ?? undefined, name: tName.trim(),
      description: tDesc, phong_ban: tDept,
    });
    setBusy(false);
    if (!r.ok) { setMsg({ text: r.error ?? "Không lưu được chủ đề", ok: false }); return; }
    setMsg({ text: "Đã lưu chủ đề.", ok: true });
    await loadTopics();
  };

  const removeTopic = async () => {
    if (!selected) return;
    setBusy(true);
    const r = await adminDeleteTopic(selected);
    setBusy(false);
    if (!r.ok) { setMsg({ text: r.error ?? "Không xoá được", ok: false }); return; }
    setSelected(null); setTName(""); setTDesc(""); setTDept("");
    setMsg({ text: "Đã xoá chủ đề.", ok: true });
    void loadTopics();
  };

  const visibleTopics = topics.filter((t) =>
    !filter || `${t.name} ${t.phong_ban} ${t.description}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
         onClick={onClose} role="presentation">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded border border-input bg-card enter-rise"
           onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="admin-title" className="text-sm font-semibold">Quản trị hệ thống</h2>
            <p className="text-[11px] text-muted-foreground">
              {users.length} người dùng · {topics.length} chủ đề · báo cáo D1/D4/D5
            </p>
          </div>
          <button onClick={onClose} aria-label="Đóng"
            className="flex size-7 items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-border px-4 py-2" role="tablist">
          {([["users", "👥 Người dùng"], ["topics", "🏷 Chủ đề / Phòng ban"], ["reports", "📊 Báo cáo"]] as const)
            .map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k}
                onClick={() => { setTab(k); setMsg(null); }}
                className={`rounded-control px-3 py-1.5 text-xs font-medium transition focus-visible:ring-3 ${
                  tab === k ? "bg-brand-soft text-brand" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}>{label}</button>
            ))}
        </div>

        {msg && (
          <p className={`mx-4 mt-2 rounded-control border px-3 py-2 text-[11px] ${
            msg.ok ? "border-brand-border bg-brand-soft text-brand"
                   : "border-destructive/40 bg-destructive/10 text-destructive"}`}>{msg.text}</p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto scroll-area-thin p-4">
          {tab === "users" && (
            <div className="space-y-4">
              <form onSubmit={(e) => { e.preventDefault(); void addUser(); }}
                className="grid gap-2 rounded-control border border-border bg-background/60 p-3 sm:grid-cols-2">
                <input value={uName} onChange={(e) => setUName(e.target.value)}
                  placeholder="Tài khoản mới" className={INPUT} />
                <input value={uPass} onChange={(e) => setUPass(e.target.value)}
                  type="password" placeholder="Mật khẩu (≥6 ký tự)" className={INPUT} />
                <input value={uDisplay} onChange={(e) => setUDisplay(e.target.value)}
                  placeholder="Tên hiển thị" className={INPUT} />
                <select value={uRole} onChange={(e) => setURole(e.target.value as AdminUser["role"])}
                  className={INPUT}>
                  {(roles.length ? roles : [
                    { id: "sinh_vien", name: "Sinh viên" },
                    { id: "can_bo", name: "Cán bộ tư vấn" },
                    { id: "admin", name: "Quản trị viên" },
                  ] as RoleOption[]).map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <button type="submit" disabled={busy || !uName.trim() || !uPass}
                  className="h-8 rounded-control bg-brand px-4 text-xs font-medium text-brand-foreground hover:opacity-90 disabled:opacity-40 sm:col-span-2">
                  + Thêm người dùng
                </button>
              </form>

              <ul className="space-y-2">
                {users.map((u) => (
                  <li key={u.username} className="rounded-control border border-border bg-background/60 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                        {u.role === "admin" ? "AD" : u.role === "can_bo" ? "CB" : "SV"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{u.display}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{u.username}</p>
                      </div>
                      <select value={u.role} disabled={busy}
                        onChange={(e) => void setRole(u.username, e.target.value as AdminUser["role"])}
                        className="h-8 rounded-control border border-input bg-background px-2 text-xs focus-visible:ring-3">
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                      <button disabled={busy} onClick={() => {
                        setPwFor(pwFor === u.username ? null : u.username); setPwDraft("");
                      }} className={`${BTN} border-border text-muted-foreground hover:text-foreground`}>
                        Đổi mật khẩu
                      </button>
                      <button disabled={busy} onClick={() => void removeUser(u.username)}
                        className={`${BTN} border-destructive/40 text-destructive hover:bg-destructive/10`}>
                        Xoá
                      </button>
                    </div>
                    {pwFor === u.username && (
                      <div className="mt-2 flex gap-2">
                        <input type="password" value={pwDraft}
                          onChange={(e) => setPwDraft(e.target.value)}
                          placeholder="Mật khẩu mới" className={INPUT} />
                        <button disabled={busy || !pwDraft} onClick={() => void savePassword(u.username)}
                          className={`${BTN} shrink-0 border-brand-border text-brand hover:bg-brand-soft`}>
                          Lưu
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground/70">
                Đổi role/mật khẩu → token cũ hết hiệu lực, người dùng đăng nhập lại.
              </p>
            </div>
          )}

          {tab === "topics" && (
            <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
              <div>
                <input value={filter} onChange={(e) => setFilter(e.target.value)}
                  placeholder="Tìm chủ đề / phòng ban..." className={INPUT} />
                <ul className="mt-2 space-y-1">
                  {visibleTopics.map((t) => (
                    <li key={t.id}>
                      <button onClick={() => pickTopic(t)}
                        className={`flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-xs transition focus-visible:ring-3 ${
                          selected === t.id ? "bg-brand-soft text-brand" : "hover:bg-accent"
                        }`}>
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        <span className="max-w-[45%] truncate text-[10px] text-muted-foreground">
                          {t.phong_ban}
                        </span>
                        {t.custom && <span className="text-[10px] text-muted-foreground">tuỳ biến</span>}
                      </button>
                    </li>
                  ))}
                  {visibleTopics.length === 0 && (
                    <p className="py-4 text-center text-xs text-muted-foreground">Không tìm thấy chủ đề.</p>
                  )}
                </ul>
              </div>
              <div className="space-y-2 rounded-control border border-border bg-background/60 p-3">
                <h3 className="text-xs font-medium">
                  {selected ? "Sửa chủ đề" : "Thêm chủ đề mới"}
                </h3>
                <input value={tName} onChange={(e) => setTName(e.target.value)}
                  placeholder="Tên chủ đề" className={INPUT} />
                <input value={tDept} onChange={(e) => setTDept(e.target.value)}
                  placeholder="Phòng ban phụ trách" className={INPUT} />
                <textarea value={tDesc} onChange={(e) => setTDesc(e.target.value)}
                  rows={4} placeholder="Mô tả" className={`${INPUT} resize-none`} />
                <button disabled={busy || !tName.trim()} onClick={() => void saveTopic()}
                  className="h-8 w-full rounded-control bg-brand text-xs font-medium text-brand-foreground hover:opacity-90 disabled:opacity-40">
                  {selected ? "Lưu thay đổi" : "+ Thêm chủ đề"}
                </button>
                {selected && (
                  <div className="flex gap-2">
                    <button onClick={() => { setSelected(null); setTName(""); setTDesc(""); setTDept(""); }}
                      className={`${BTN} flex-1 border-border text-muted-foreground`}>
                      Bỏ chọn
                    </button>
                    <button disabled={busy} onClick={() => void removeTopic()}
                      className={`${BTN} flex-1 border-destructive/40 text-destructive`}>
                      Xoá
                    </button>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground/70">
                  23 chủ đề gốc (theo hashtag) chỉ sửa tên/mô tả/phòng ban, không xoá được.
                </p>
              </div>
            </div>
          )}

          {tab === "reports" && (
            <ReportsView report={report} onRefresh={() => void loadReport()} />
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-border px-4 py-2.5">
          <button onClick={onClose}
            className="h-7 rounded-control bg-secondary px-3 text-xs font-medium hover:bg-accent">
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportsView({ report, onRefresh }: {
  report: ReportData | null;
  onRefresh: () => void;
}) {
  if (!report) {
    return <p className="py-8 text-center text-xs text-muted-foreground">Đang tải báo cáo...</p>;
  }
  const o = report.overview;
  const cards: { label: string; value: string | number }[] = [
    { label: "Tin nhắn", value: o.n_messages },
    { label: "Phiên chat", value: o.n_sessions },
    { label: "Người dùng", value: o.n_users },
    { label: "Đánh giá", value: o.n_feedback },
    { label: "★ TB", value: o.avg_stars },
    { label: "Tỷ lệ hữu ích", value: `${Math.round(o.ratio_up * 100)}%` },
    { label: "Hàng chờ", value: o.hang_cho_pending },
    { label: "Đã trả lời", value: o.hang_cho_done },
    { label: "Tri thức chờ duyệt", value: o.docs_pending },
    { label: "Tri thức đã duyệt", value: o.docs_approved },
    { label: "Đáp án chờ soát", value: o.review_pending },
    { label: "Đáp án đã duyệt", value: o.review_approved },
  ];
  const maxActivity = Math.max(1, ...report.activity.map((a) => a.messages + a.feedback + a.hang_cho));

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground/70">Tổng quan</h3>
        <button onClick={onRefresh}
          className="ml-auto h-7 rounded-control border border-border px-2.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:ring-3">
          ↻ Làm mới
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-control border border-border bg-background/60 p-3">
            <p className="text-[11px] text-muted-foreground">{c.label}</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">{c.value}</p>
          </div>
        ))}
      </div>

      <section>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground/70">
          Hoạt động 7 ngày (tin nhắn / đánh giá / hàng chờ)
        </h3>
        <div className="flex h-32 items-end gap-2 rounded-control border border-border bg-background/60 p-3">
          {report.activity.map((a) => {
            const total = a.messages + a.feedback + a.hang_cho;
            return (
              <div key={a.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
                title={`${a.date}: ${a.messages} tin nhắn, ${a.feedback} đánh giá, ${a.hang_cho} hàng chờ`}>
                <span className="text-[10px] tabular-nums text-muted-foreground">{total || ""}</span>
                <div className="flex w-full flex-col justify-end" style={{ height: `${(total / maxActivity) * 90}%` }}>
                  {a.hang_cho > 0 && <span className="block w-full bg-warning/70" style={{ height: `${(a.hang_cho / Math.max(1, total)) * 100}%` }} />}
                  {a.feedback > 0 && <span className="block w-full bg-brand/70" style={{ height: `${(a.feedback / Math.max(1, total)) * 100}%` }} />}
                  {a.messages > 0 && <span className="block w-full bg-muted-foreground/40" style={{ height: `${(a.messages / Math.max(1, total)) * 100}%` }} />}
                </div>
                <span className="truncate font-mono text-[9px] text-muted-foreground/60">{a.date.slice(5)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground/70">Quyết định router</h3>
          <ul className="space-y-1 text-xs">
            {report.decisions.map((d) => (
              <li key={d.name} className="flex justify-between rounded-control bg-background/60 px-3 py-1.5">
                <span>{d.name}</span><span className="tabular-nums">{d.n}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground/70">Câu hỏi phổ biến</h3>
          <ul className="space-y-1 text-xs">
            {report.top_questions.map((q) => (
              <li key={q.question} className="flex justify-between gap-2 rounded-control bg-background/60 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate">{q.question}</span>
                <span className="tabular-nums text-muted-foreground">{q.n}</span>
              </li>
            ))}
            {report.top_questions.length === 0 && (
              <li className="text-muted-foreground">Chưa có dữ liệu.</li>
            )}
          </ul>
        </section>
      </div>

      {report.staff_replies.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground/70">Cán bộ trả lời hàng chờ</h3>
          <ul className="flex flex-wrap gap-2 text-xs">
            {report.staff_replies.map((s) => (
              <li key={s.name} className="rounded-full border border-border px-3 py-1">
                {s.name} · <span className="tabular-nums">{s.n}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-[10px] text-muted-foreground/60">
        Cập nhật lúc {report.generated_at.replace("T", " ").slice(0, 19)}
      </p>
    </div>
  );
}
