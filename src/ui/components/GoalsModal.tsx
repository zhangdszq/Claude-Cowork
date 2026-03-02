import { useEffect, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "../store/useAppStore";

interface AssistantConfig {
  id: string;
  name: string;
  defaultCwd?: string;
}

interface GoalProgressEntry {
  sessionId: string;
  runAt: string;
  summary: string;
  isComplete: boolean;
  nextSteps?: string;
}

interface LongTermGoal {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused" | "completed" | "abandoned";
  assistantId?: string;
  cwd?: string;
  retryInterval: number;
  maxRuns: number;
  totalRuns: number;
  progressLog: GoalProgressEntry[];
  nextRunAt?: string;
  consecutiveErrors?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

type ViewMode = "list" | "create" | "detail";

interface GoalsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Helpers ──────────────────────────────────────────────────

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

function formatNextRun(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "即将运行";
  const min = Math.ceil(diff / 60000);
  if (min < 60) return `${min} 分钟后`;
  return `${Math.ceil(min / 60)} 小时后`;
}

function formatDuration(createdAt: string, completedAt?: string): string {
  const start = new Date(createdAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const h = Math.floor((end - start) / 3600000);
  if (h < 1) return "不到1小时";
  if (h < 24) return `${h}小时`;
  return `${Math.floor(h / 24)}天`;
}

// ─── Sub-components ───────────────────────────────────────────

function StatusBadge({ status, isRunning }: { status: LongTermGoal["status"]; isRunning?: boolean }) {
  if (isRunning) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-info/12 px-2.5 py-1 text-[11px] font-semibold text-info">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-info" />
        </span>
        运行中
      </span>
    );
  }
  const map: Record<LongTermGoal["status"], { label: string; cls: string }> = {
    active:    { label: "进行中",  cls: "bg-emerald-500/12 text-emerald-700" },
    paused:    { label: "已暂停",  cls: "bg-amber-500/12 text-amber-700" },
    completed: { label: "已完成",  cls: "bg-accent/12 text-accent" },
    abandoned: { label: "已放弃",  cls: "bg-ink-900/8 text-ink-500" },
  };
  const { label, cls } = map[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function ProgressRing({ value, size = 40, stroke = 3, color = "stroke-accent" }: {
  value: number; size?: number; stroke?: number; color?: string;
}) {
  const r = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(value, 1));
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-ink-900/8" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round"
        className={color}
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
    </svg>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl bg-surface-secondary px-4 py-3 text-center min-w-0">
      <span className="text-lg font-bold text-ink-800 tabular-nums leading-none">{value}</span>
      {sub && <span className="text-[10px] text-muted mt-0.5">{sub}</span>}
      <span className="text-[11px] text-muted mt-1">{label}</span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────

export function GoalsModal({ open, onOpenChange }: GoalsModalProps) {
  const [goals, setGoals] = useState<LongTermGoal[]>([]);
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ViewMode>("list");
  const [selectedGoal, setSelectedGoal] = useState<LongTermGoal | null>(null);

  const sessions = useAppStore((s) => s.sessions);
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);

  // Create form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cwd, setCwd] = useState("");
  const [assistantId, setAssistantId] = useState("");
  const [retryInterval, setRetryInterval] = useState(30);
  const [maxRuns, setMaxRuns] = useState(20);

  const loadGoals = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.electron.goalsList();
      setGoals(list ?? []);
      if (selectedGoal) {
        const fresh = (list ?? []).find((g: LongTermGoal) => g.id === selectedGoal.id);
        if (fresh) setSelectedGoal(fresh);
      }
    } catch (e) {
      console.error("Failed to load goals:", e);
    } finally {
      setLoading(false);
    }
  }, [selectedGoal]);

  useEffect(() => {
    if (open) { loadGoals(); setMode("list"); setSelectedGoal(null); }
  }, [open]); // eslint-disable-line

  useEffect(() => {
    if (!open || typeof window.electron.onGoalCompleted !== "function") return;
    return window.electron.onGoalCompleted(() => loadGoals());
  }, [open, loadGoals]);

  useEffect(() => {
    window.electron.getAssistantsConfig().then((cfg) => setAssistants(cfg.assistants ?? [])).catch(console.error);
  }, []);

  // Detect running goals from session list
  const runningGoalNames = new Set<string>(
    Object.values(sessions)
      .filter((s) => s.status === "running" && s.title?.startsWith("[目标]"))
      .flatMap((s) => {
        const m = s.title?.match(/^\[目标\]\s+(.+?)\s+-\s+第\d+次$/);
        return m ? [m[1]] : [];
      })
  );

  const getRunningSession = (goalName: string) =>
    Object.values(sessions).find((s) =>
      s.status === "running" &&
      s.title?.match(new RegExp(`^\\[目标\\]\\s+${goalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+-\\s+第\\d+次$`))
    );

  // ── handlers ──

  const resetForm = () => {
    setName(""); setDescription(""); setCwd("");
    setAssistantId(""); setRetryInterval(30); setMaxRuns(20);
  };

  const handleSave = async () => {
    if (!name.trim() || !description.trim()) return;
    setLoading(true);
    try {
      await window.electron.goalsAdd({ name: name.trim(), description: description.trim(), cwd: cwd.trim() || undefined, assistantId: assistantId || undefined, retryInterval, maxRuns });
      await loadGoals();
      setMode("list"); resetForm();
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const handleTogglePause = async (goal: LongTermGoal) => {
    const newStatus = goal.status === "active" ? "paused" : "active";
    try {
      const updated = await window.electron.goalsUpdate(goal.id, { status: newStatus });
      if (updated) setSelectedGoal(updated);
      await loadGoals();
    } catch (e) { console.error(e); }
  };

  const handleAbandon = async (goal: LongTermGoal) => {
    if (!confirm(`确定要放弃「${goal.name}」吗？`)) return;
    await window.electron.goalsUpdate(goal.id, { status: "abandoned" });
    await loadGoals(); setMode("list"); setSelectedGoal(null);
  };

  const handleDelete = async (goal: LongTermGoal) => {
    if (!confirm(`确定要删除「${goal.name}」吗？进度记录也会一并删除。`)) return;
    await window.electron.goalsDelete(goal.id);
    await loadGoals(); setMode("list"); setSelectedGoal(null);
  };

  const handleRunNow = async (goal: LongTermGoal) => {
    await window.electron.goalsRunNow(goal.id);
    setTimeout(loadGoals, 800);
  };

  const handleJumpToSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    onOpenChange(false);
  };

  const handleSelectDirectory = async () => {
    const path = await window.electron.selectDirectory();
    if (path) setCwd(path);
  };

  // Summary stats for header area
  const activeCount = goals.filter((g) => g.status === "active").length;
  const completedCount = goals.filter((g) => g.status === "completed").length;

  // ── render ──

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/20 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl h-[82vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/5 bg-surface shadow-elevated overflow-hidden flex flex-col">

          {/* ── Header ── */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-ink-900/8 shrink-0">
            <div className="flex items-center gap-2.5">
              {mode !== "list" ? (
                <button onClick={() => { setMode("list"); setSelectedGoal(null); resetForm(); }}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
                  </svg>
                </div>
              )}
              <div>
                <Dialog.Title className="text-[15px] font-semibold text-ink-800 leading-tight">
                  {mode === "list" ? "长期目标" : mode === "create" ? "新建目标" : selectedGoal?.name ?? "目标详情"}
                </Dialog.Title>
                {mode === "list" && goals.length > 0 && (
                  <p className="text-[11px] text-muted leading-tight">
                    {activeCount > 0 ? `${activeCount} 个进行中` : ""}
                    {activeCount > 0 && completedCount > 0 ? " · " : ""}
                    {completedCount > 0 ? `${completedCount} 个已完成` : ""}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {mode === "list" && (
                <>
                  <button onClick={loadGoals} disabled={loading}
                    className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors disabled:opacity-40">
                    <svg viewBox="0 0 24 24" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                  </button>
                  <button onClick={() => { resetForm(); setMode("create"); }}
                    className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover transition-colors shadow-sm">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
                    新建目标
                  </button>
                </>
              )}
              <Dialog.Close asChild>
                <button className="rounded-full p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </Dialog.Close>
            </div>
          </div>

          {/* ── Body ── */}
          <div className="flex-1 overflow-y-auto">

            {/* ── LIST ── */}
            {mode === "list" && (
              <div className="p-4">
                {!loading && goals.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
                    <div className="relative">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/8">
                        <svg viewBox="0 0 24 24" className="h-8 w-8 text-accent/60" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
                          <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
                        </svg>
                      </div>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-ink-700">还没有长期目标</p>
                      <p className="text-xs text-muted mt-1 max-w-[260px]">创建目标后，AI 将自动分多次会话推进，直到完成为止。</p>
                    </div>
                    <button onClick={() => { resetForm(); setMode("create"); }}
                      className="rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors shadow-soft">
                      新建第一个目标
                    </button>
                  </div>
                )}

                <div className="space-y-2.5">
                  {goals.map((goal) => {
                    const pct = goal.maxRuns > 0 ? Math.min(goal.totalRuns / goal.maxRuns, 1) : 0;
                    const lastEntry = goal.progressLog[goal.progressLog.length - 1];
                    const isRunning = runningGoalNames.has(goal.name);
                    const errCount = goal.consecutiveErrors ?? 0;

                    return (
                      <div key={goal.id} onClick={() => { setSelectedGoal(goal); setMode("detail"); }}
                        className="group relative flex gap-4 rounded-2xl border border-ink-900/6 bg-surface p-4 cursor-pointer hover:border-ink-900/12 hover:shadow-sm transition-all active:scale-[0.995]">

                        {/* Left: ring progress */}
                        <div className="relative shrink-0 flex items-center justify-center">
                          <ProgressRing value={pct} size={48} stroke={3.5}
                            color={goal.status === "completed" ? "stroke-accent" : isRunning ? "stroke-info" : goal.status === "active" ? "stroke-emerald-500" : "stroke-ink-900/20"} />
                          <span className="absolute text-[10px] font-bold tabular-nums text-ink-700">
                            {Math.round(pct * 100)}%
                          </span>
                        </div>

                        {/* Right: content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <h3 className="text-sm font-semibold text-ink-800 truncate">{goal.name}</h3>
                            <StatusBadge status={goal.status} isRunning={isRunning} />
                          </div>

                          <p className="text-xs text-muted line-clamp-1 mb-2">
                            {lastEntry ? lastEntry.summary : goal.description}
                          </p>

                          <div className="flex items-center gap-3 text-[11px] text-muted flex-wrap">
                            <span className="tabular-nums">{goal.totalRuns}/{goal.maxRuns} 次</span>
                            {goal.nextRunAt && goal.status === "active" && !isRunning && (
                              <span className="flex items-center gap-1">
                                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
                                {formatNextRun(goal.nextRunAt)}
                              </span>
                            )}
                            {lastEntry && (
                              <span className="flex items-center gap-1">
                                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
                                {formatTimeAgo(lastEntry.runAt)}
                              </span>
                            )}
                            {errCount > 0 && (
                              <span className="flex items-center gap-1 text-error font-medium">
                                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                                连续出错 {errCount} 次
                              </span>
                            )}
                          </div>
                        </div>

                        <svg viewBox="0 0 24 24" className="h-4 w-4 text-ink-300 shrink-0 self-center opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── CREATE ── */}
            {mode === "create" && (
              <div className="p-6">
                <div className="max-w-lg mx-auto space-y-5">

                  {/* Name + Assistant row */}
                  <div className="grid grid-cols-2 gap-3">
                    <label className="col-span-2">
                      <span className="text-xs font-medium text-muted">目标名称</span>
                      <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus
                        placeholder="例如：重构后端 API、完成测试覆盖"
                        className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 transition-all" />
                    </label>
                    <label className="col-span-2">
                      <span className="text-xs font-medium text-muted">目标描述</span>
                      <p className="text-[11px] text-muted-light mt-0.5 mb-1.5">越详细 AI 越能精准推进，建议包含完成标准</p>
                      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
                        placeholder="完成后端 API 全面重构：统一错误处理格式、补全 OpenAPI 文档注释、将所有路由切换到新版本…"
                        className="w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 transition-all resize-none" />
                    </label>
                  </div>

                  {/* Separator */}
                  <div className="border-t border-ink-900/8" />

                  {/* Assistant + CWD */}
                  <div className="grid grid-cols-2 gap-3">
                    <label>
                      <span className="text-xs font-medium text-muted">执行助理</span>
                      <select value={assistantId} onChange={(e) => {
                        const aid = e.target.value;
                        setAssistantId(aid);
                        // Auto-fill CWD from assistant's defaultCwd if currently empty
                        if (!cwd.trim()) {
                          const a = assistants.find((x) => x.id === aid);
                          if (a?.defaultCwd) setCwd(a.defaultCwd);
                        }
                      }}
                        className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 transition-all">
                        <option value="">默认助理</option>
                        {assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="text-xs font-medium text-muted">工作目录</span>
                      {(() => {
                        const fallbackCwd = assistants.find((a) => a.id === assistantId)?.defaultCwd;
                        return (
                          <p className="text-[11px] text-muted-light mt-0.5 mb-1.5">
                            {cwd.trim()
                              ? ""
                              : fallbackCwd
                              ? `未填写将使用助理默认目录：${fallbackCwd}`
                              : "建议指定工作目录，否则 AI 将在应用安装目录下运行"}
                          </p>
                        );
                      })()}
                      <div className="mt-1 flex gap-1.5">
                        <input type="text" value={cwd} onChange={(e) => setCwd(e.target.value)}
                          placeholder="输入或选择项目目录…"
                          className="flex-1 min-w-0 rounded-xl border border-ink-900/10 bg-surface-secondary px-3 py-2.5 text-xs text-ink-700 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 transition-all" />
                        <button onClick={handleSelectDirectory}
                          className="shrink-0 rounded-xl border border-ink-900/10 bg-surface-secondary px-3 py-2.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors">
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                        </button>
                      </div>
                    </label>
                  </div>

                  {/* Separator */}
                  <div className="border-t border-ink-900/8" />

                  {/* Interval + MaxRuns */}
                  <div>
                    <p className="text-xs font-medium text-muted mb-3">调度设置</p>
                    <div className="grid grid-cols-2 gap-3">
                      <label>
                        <span className="text-xs text-muted">两次运行间隔</span>
                        <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5">
                          <input type="number" min="0" max="1440" value={retryInterval}
                            onChange={(e) => setRetryInterval(parseInt(e.target.value) || 0)}
                            className="w-16 bg-transparent text-sm font-semibold text-ink-800 focus:outline-none tabular-nums" />
                          <span className="text-xs text-muted">分钟</span>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-light">0 = 完成后立即续跑</p>
                      </label>
                      <label>
                        <span className="text-xs text-muted">最大运行次数</span>
                        <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5">
                          <input type="number" min="1" max="200" value={maxRuns}
                            onChange={(e) => setMaxRuns(parseInt(e.target.value) || 20)}
                            className="w-16 bg-transparent text-sm font-semibold text-ink-800 focus:outline-none tabular-nums" />
                          <span className="text-xs text-muted">次</span>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-light">超出后自动放弃目标</p>
                      </label>
                    </div>
                  </div>

                  {/* Tip */}
                  <div className="flex gap-2.5 rounded-xl bg-accent/6 border border-accent/10 px-4 py-3">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
                    <p className="text-[11px] text-ink-700 leading-relaxed">
                      创建后立即启动第一次运行。AI 每次运行后会自主判断目标是否达成，未完成则按间隔自动续跑，连续出错 3 次会自动暂停。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ── DETAIL ── */}
            {mode === "detail" && selectedGoal && (() => {
              const goal = selectedGoal;
              const isRunning = runningGoalNames.has(goal.name);
              const runningSession = getRunningSession(goal.name);
              const pct = goal.maxRuns > 0 ? Math.min(goal.totalRuns / goal.maxRuns, 1) : 0;
              const errCount = goal.consecutiveErrors ?? 0;

              return (
                <div className="p-5 space-y-5">

                  {/* ── Top stat cards ── */}
                  <div className="grid grid-cols-4 gap-2">
                    <StatCard label="已运行" value={goal.totalRuns} sub={`/ ${goal.maxRuns}`} />
                    <StatCard label="完成率" value={`${Math.round(pct * 100)}%`} />
                    <StatCard label="连续出错" value={errCount} sub={errCount >= 3 ? "已暂停" : "次"} />
                    <StatCard label="运行时长" value={formatDuration(goal.createdAt, goal.completedAt)} />
                  </div>

                  {/* ── Description block ── */}
                  <div className="rounded-xl bg-surface-secondary/70 border border-ink-900/6 p-4">
                    <p className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">目标描述</p>
                    <p className="text-sm text-ink-700 leading-relaxed whitespace-pre-wrap">{goal.description}</p>
                    <div className="mt-2.5 flex items-center gap-1.5 text-[11px]">
                      <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                      {goal.cwd ? (
                        <span className="font-mono text-ink-600 truncate">{goal.cwd}</span>
                      ) : (
                        <span className="text-amber-600 font-medium">未指定工作目录（使用应用默认目录）</span>
                      )}
                    </div>
                  </div>

                  {/* ── Status / running info ── */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={goal.status} isRunning={isRunning} />
                      {goal.nextRunAt && goal.status === "active" && !isRunning && (
                        <span className="flex items-center gap-1 text-xs text-muted rounded-full bg-surface-secondary px-2.5 py-1">
                          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
                          {formatNextRun(goal.nextRunAt)}
                        </span>
                      )}
                      {goal.completedAt && (
                        <span className="text-xs text-muted">完成于 {new Date(goal.completedAt).toLocaleDateString("zh-CN")}</span>
                      )}
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1.5">
                      {isRunning && runningSession && (
                        <button onClick={() => handleJumpToSession(runningSession.id)}
                          className="flex items-center gap-1.5 rounded-xl border border-info/25 bg-info/8 px-3 py-1.5 text-xs font-medium text-info hover:bg-info/15 transition-colors">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 3l14 9-14 9V3z" /></svg>
                          查看
                        </button>
                      )}
                      {(goal.status === "active" || goal.status === "paused") && (
                        <>
                          <button onClick={() => handleTogglePause(goal)}
                            className="flex items-center gap-1.5 rounded-xl border border-ink-900/10 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-surface-tertiary transition-colors">
                            {goal.status === "active" ? (
                              <><svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>暂停</>
                            ) : (
                              <><svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>恢复</>
                            )}
                          </button>
                          {goal.status === "active" && !isRunning && (
                            <button onClick={() => handleRunNow(goal)}
                              className="flex items-center gap-1.5 rounded-xl border border-ink-900/10 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-surface-tertiary transition-colors">
                              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 3l14 9-14 9V3z" /></svg>
                              立即运行
                            </button>
                          )}
                          <button onClick={() => handleAbandon(goal)}
                            className="rounded-xl border border-ink-900/10 px-3 py-1.5 text-xs font-medium text-error hover:bg-error/5 transition-colors">
                            放弃
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* ── Progress log ── */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                        进度日志 ({goal.progressLog.length})
                      </p>
                    </div>

                    {goal.progressLog.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-10 text-center">
                        <svg viewBox="0 0 24 24" className="h-8 w-8 text-ink-900/15" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /></svg>
                        <p className="text-xs text-muted-light">第一次运行后这里会出现进度记录</p>
                      </div>
                    ) : (
                      <div className="relative">
                        {/* Vertical line */}
                        <div className="absolute left-[15px] top-4 bottom-4 w-px bg-ink-900/8" />
                        <div className="space-y-1">
                          {[...goal.progressLog].reverse().map((entry, i) => {
                            const sessionExists = !!sessions[entry.sessionId];
                            const isFirst = i === 0;
                            return (
                              <div key={entry.sessionId} className={`relative flex gap-3 rounded-xl p-3 transition-colors ${isFirst ? "bg-surface-secondary/60" : "hover:bg-surface-secondary/40"}`}>
                                {/* Dot */}
                                <div className={`relative z-10 mt-0.5 h-[14px] w-[14px] shrink-0 rounded-full border-2 ${
                                  entry.isComplete ? "border-accent bg-accent/20" : "border-emerald-400 bg-emerald-400/15"
                                }`} />

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <span className="text-[11px] font-medium text-muted">
                                      {new Date(entry.runAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                    <span className="text-[11px] text-muted-light">{formatTimeAgo(entry.runAt)}</span>
                                    {entry.isComplete && (
                                      <span className="rounded-full bg-accent/12 px-2 py-0.5 text-[10px] font-semibold text-accent">目标达成</span>
                                    )}
                                    {sessionExists && (
                                      <button onClick={() => handleJumpToSession(entry.sessionId)}
                                        className="ml-auto rounded-lg px-2 py-0.5 text-[10px] font-medium text-muted hover:text-accent hover:bg-accent/8 transition-colors">
                                        查看会话 →
                                      </button>
                                    )}
                                  </div>
                                  <p className="text-[13px] text-ink-700 leading-relaxed">{entry.summary}</p>
                                  {entry.nextSteps && !entry.isComplete && (
                                    <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted">
                                      <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                                      {entry.nextSteps}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── Footer actions ── */}
                  <div className="flex justify-end pt-2 border-t border-ink-900/8">
                    <button onClick={() => handleDelete(goal)}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-error/70 hover:text-error hover:bg-error/8 transition-colors">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                      删除目标
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* ── Create footer ── */}
          {mode === "create" && (
            <div className="px-6 py-4 border-t border-ink-900/8 bg-surface-secondary/40 shrink-0">
              <div className="max-w-lg mx-auto">
                <button onClick={handleSave} disabled={loading || !name.trim() || !description.trim()}
                  className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-soft hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50">
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      创建中…
                    </span>
                  ) : "创建并启动目标"}
                </button>
              </div>
            </div>
          )}

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
