import { useEffect, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  cwd?: string;
  skillPath?: string;
  scheduleType: "once" | "interval";
  scheduledTime?: string;
  intervalValue?: number;
  intervalUnit?: "minutes" | "hours" | "days" | "weeks";
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
  updatedAt: string;
}

interface SchedulerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type EditMode = "list" | "create" | "edit";

export function SchedulerModal({ open, onOpenChange }: SchedulerModalProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [mode, setMode] = useState<EditMode>("list");
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [loading, setLoading] = useState(false);
  
  // Form state
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [scheduleType, setScheduleType] = useState<"once" | "interval">("once");
  const [scheduledTime, setScheduledTime] = useState("");
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours" | "days" | "weeks">("hours");

  // Load tasks
  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const loadedTasks = await window.electron.getScheduledTasks();
      setTasks(loadedTasks);
    } catch (error) {
      console.error("Failed to load tasks:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadTasks();
      setMode("list");
    }
  }, [open, loadTasks]);

  // Reset form
  const resetForm = () => {
    setName("");
    setPrompt("");
    setCwd("");
    setScheduleType("once");
    setScheduledTime("");
    setIntervalValue(1);
    setIntervalUnit("hours");
    setEditingTask(null);
  };

  // Start creating new task
  const handleCreate = () => {
    resetForm();
    // Set default scheduled time to 1 hour from now
    const defaultTime = new Date();
    defaultTime.setHours(defaultTime.getHours() + 1);
    defaultTime.setMinutes(0);
    defaultTime.setSeconds(0);
    setScheduledTime(defaultTime.toISOString().slice(0, 16));
    setMode("create");
  };

  // Start editing task
  const handleEdit = (task: ScheduledTask) => {
    setEditingTask(task);
    setName(task.name);
    setPrompt(task.prompt);
    setCwd(task.cwd || "");
    setScheduleType(task.scheduleType);
    if (task.scheduledTime) {
      setScheduledTime(new Date(task.scheduledTime).toISOString().slice(0, 16));
    }
    setIntervalValue(task.intervalValue || 1);
    setIntervalUnit(task.intervalUnit || "hours");
    setMode("edit");
  };

  // Save task
  const handleSave = async () => {
    if (!name.trim() || !prompt.trim()) return;

    setLoading(true);
    try {
      const taskData = {
        name: name.trim(),
        enabled: true,
        prompt: prompt.trim(),
        cwd: cwd.trim() || undefined,
        scheduleType,
        scheduledTime: scheduleType === "once" ? new Date(scheduledTime).toISOString() : undefined,
        intervalValue: scheduleType === "interval" ? intervalValue : undefined,
        intervalUnit: scheduleType === "interval" ? intervalUnit : undefined,
      };

      if (mode === "edit" && editingTask) {
        await window.electron.updateScheduledTask(editingTask.id, taskData);
      } else {
        await window.electron.addScheduledTask(taskData);
      }

      await loadTasks();
      setMode("list");
      resetForm();
    } catch (error) {
      console.error("Failed to save task:", error);
    } finally {
      setLoading(false);
    }
  };

  // Delete task
  const handleDelete = async (id: string) => {
    if (!confirm("确定要删除这个定时任务吗？")) return;

    setLoading(true);
    try {
      await window.electron.deleteScheduledTask(id);
      await loadTasks();
    } catch (error) {
      console.error("Failed to delete task:", error);
    } finally {
      setLoading(false);
    }
  };

  // Toggle task enabled
  const handleToggle = async (task: ScheduledTask) => {
    setLoading(true);
    try {
      await window.electron.updateScheduledTask(task.id, { enabled: !task.enabled });
      await loadTasks();
    } catch (error) {
      console.error("Failed to toggle task:", error);
    } finally {
      setLoading(false);
    }
  };

  // Select directory
  const handleSelectDirectory = async () => {
    try {
      const path = await window.electron.selectDirectory();
      if (path) setCwd(path);
    } catch (error) {
      console.error("Failed to select directory:", error);
    }
  };

  // Format next run time
  const formatNextRun = (nextRun?: string) => {
    if (!nextRun) return "未设置";
    const date = new Date(nextRun);
    const now = new Date();
    const diff = date.getTime() - now.getTime();
    
    if (diff < 0) return "已过期";
    if (diff < 60 * 1000) return "即将执行";
    if (diff < 60 * 60 * 1000) return `${Math.round(diff / 60000)} 分钟后`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)} 小时后`;
    return date.toLocaleString("zh-CN");
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/20 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl max-h-[85vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/5 bg-surface shadow-elevated overflow-hidden flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-ink-900/10">
            <div className="flex items-center gap-3">
              {mode !== "list" && (
                <button
                  onClick={() => { setMode("list"); resetForm(); }}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
              )}
              <Dialog.Title className="text-base font-semibold text-ink-800">
                {mode === "list" ? "定时任务" : mode === "create" ? "新建任务" : "编辑任务"}
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                className="rounded-full p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {mode === "list" ? (
              /* Task List */
              <div className="space-y-3">
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <svg className="h-6 w-6 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </div>
                ) : tasks.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-5xl mb-4">⏰</div>
                    <div className="text-ink-700 font-medium mb-2">没有定时任务</div>
                    <div className="text-sm text-muted">创建定时任务来自动运行会话</div>
                  </div>
                ) : (
                  tasks.map((task) => (
                    <div
                      key={task.id}
                      className={`rounded-xl border p-4 transition-colors ${
                        task.enabled 
                          ? "border-accent/30 bg-accent/5" 
                          : "border-ink-900/10 bg-surface-secondary"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-ink-800 truncate">{task.name}</span>
                            {task.enabled && (
                              <span className="text-xs text-accent bg-accent/10 px-2 py-0.5 rounded-full">
                                已启用
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted truncate mb-2">{task.prompt}</div>
                          <div className="flex items-center gap-4 text-xs text-muted">
                            <span className="flex items-center gap-1">
                              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" />
                                <path d="M12 6v6l4 2" />
                              </svg>
                              {task.scheduleType === "once" 
                                ? "单次执行" 
                                : `每 ${task.intervalValue} ${
                                    task.intervalUnit === "minutes" ? "分钟" :
                                    task.intervalUnit === "hours" ? "小时" :
                                    task.intervalUnit === "days" ? "天" : "周"
                                  }`
                              }
                            </span>
                            {task.enabled && (
                              <span className="flex items-center gap-1 text-accent">
                                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M5 12h14M12 5l7 7-7 7" />
                                </svg>
                                {formatNextRun(task.nextRun)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleToggle(task)}
                            className={`relative w-10 h-6 rounded-full transition-colors ${
                              task.enabled ? "bg-accent" : "bg-ink-900/20"
                            }`}
                          >
                            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
                              task.enabled ? "left-5" : "left-1"
                            }`} />
                          </button>
                          <button
                            onClick={() => handleEdit(task)}
                            className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDelete(task.id)}
                            className="rounded-lg p-1.5 text-muted hover:bg-error/10 hover:text-error transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}

                <button
                  onClick={handleCreate}
                  className="w-full rounded-xl border-2 border-dashed border-ink-900/20 py-4 text-sm text-muted hover:border-accent hover:text-accent transition-colors"
                >
                  + 新建定时任务
                </button>
              </div>
            ) : (
              /* Create/Edit Form */
              <div className="space-y-4">
                <label className="block">
                  <span className="text-xs font-medium text-muted">任务名称</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：每日视频剪辑"
                    className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-muted">执行指令</span>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="输入要执行的任务指令..."
                    rows={3}
                    className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors resize-none"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-muted">工作目录 (可选)</span>
                  <div className="mt-1.5 flex gap-2">
                    <input
                      type="text"
                      value={cwd}
                      onChange={(e) => setCwd(e.target.value)}
                      placeholder="选择工作目录..."
                      className="flex-1 rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                      readOnly
                    />
                    <button
                      onClick={handleSelectDirectory}
                      className="rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-muted hover:bg-surface-tertiary transition-colors"
                    >
                      浏览
                    </button>
                  </div>
                </label>

                <div className="border-t border-ink-900/10 pt-4">
                  <span className="text-xs font-medium text-muted">执行时间</span>
                  
                  <div className="mt-3 flex gap-3">
                    <button
                      onClick={() => setScheduleType("once")}
                      className={`flex-1 rounded-xl border py-3 text-sm font-medium transition-colors ${
                        scheduleType === "once"
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-ink-900/10 text-muted hover:border-ink-900/20"
                      }`}
                    >
                      单次执行
                    </button>
                    <button
                      onClick={() => setScheduleType("interval")}
                      className={`flex-1 rounded-xl border py-3 text-sm font-medium transition-colors ${
                        scheduleType === "interval"
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-ink-900/10 text-muted hover:border-ink-900/20"
                      }`}
                    >
                      定时重复
                    </button>
                  </div>

                  {scheduleType === "once" ? (
                    <label className="block mt-4">
                      <span className="text-xs font-medium text-muted">执行时间</span>
                      <input
                        type="datetime-local"
                        value={scheduledTime}
                        onChange={(e) => setScheduledTime(e.target.value)}
                        className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                      />
                    </label>
                  ) : (
                    <div className="mt-4 flex gap-3">
                      <label className="flex-1">
                        <span className="text-xs font-medium text-muted">间隔</span>
                        <input
                          type="number"
                          min="1"
                          value={intervalValue}
                          onChange={(e) => setIntervalValue(parseInt(e.target.value) || 1)}
                          className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                        />
                      </label>
                      <label className="flex-1">
                        <span className="text-xs font-medium text-muted">单位</span>
                        <select
                          value={intervalUnit}
                          onChange={(e) => setIntervalUnit(e.target.value as any)}
                          className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                        >
                          <option value="minutes">分钟</option>
                          <option value="hours">小时</option>
                          <option value="days">天</option>
                          <option value="weeks">周</option>
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          {mode !== "list" && (
            <div className="px-6 py-4 border-t border-ink-900/10 bg-surface-secondary/50">
              <button
                onClick={handleSave}
                disabled={loading || !name.trim() || !prompt.trim()}
                className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    保存中...
                  </span>
                ) : mode === "edit" ? (
                  "保存修改"
                ) : (
                  "创建任务"
                )}
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
