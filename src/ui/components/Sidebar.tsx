import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "../store/useAppStore";
import { SettingsModal } from "./SettingsModal";
import { AssistantManagerModal } from "./AssistantManagerModal";
import { SchedulerModal } from "./SchedulerModal";

const ASSISTANT_CWDS_KEY = "vk-cowork-assistant-cwds";
function loadAssistantCwdLocal(assistantId: string | null): string {
  if (!assistantId) return "";
  try {
    const map = JSON.parse(localStorage.getItem(ASSISTANT_CWDS_KEY) || "{}");
    return map[assistantId] ?? "";
  } catch { return ""; }
}

interface SidebarProps {
  connected: boolean;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  width: number;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onOpenSkill?: () => void;
  onOpenMcp?: () => void;
  onNoWorkspace?: () => void;
}

export function Sidebar({
  onNewSession,
  onDeleteSession,
  width,
  onResizeStart,
  onOpenSkill,
  onOpenMcp,
  onNoWorkspace,
}: SidebarProps) {
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const setActiveSessionId = useAppStore((state) => state.setActiveSessionId);
  const selectedAssistantId = useAppStore((state) => state.selectedAssistantId);
  const setSelectedAssistant = useAppStore((state) => state.setSelectedAssistant);
  const setCwd = useAppStore((state) => state.setCwd);

  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAssistantManager, setShowAssistantManager] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const formatCwd = (cwd?: string) => {
    if (!cwd) return "Working dir unavailable";
    const parts = cwd.split(/[\\/]+/).filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return `/${tail || cwd}`;
  };

  const sessionList = useMemo(() => {
    const list = Object.values(sessions);
    list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return list;
  }, [sessions]);

  const loadAssistants = useCallback(() => {
    window.electron.getAssistantsConfig().then((config) => {
      const list = config.assistants ?? [];
      setAssistants(list);
      if (!list.length) return;
      const currentId = useAppStore.getState().selectedAssistantId;
      const fallbackId = config.defaultAssistantId ?? list[0]?.id;
      const targetId = list.some((item) => item.id === currentId) ? currentId : fallbackId;
      const target = list.find((item) => item.id === targetId) ?? list[0];
      if (target) {
        setSelectedAssistant(target.id, target.skillNames ?? [], target.provider, target.model, target.persona);
        // 从 localStorage 恢复该助理的工作区（仅当 cwd 为空时）
        if (!useAppStore.getState().cwd) {
          const savedCwd = loadAssistantCwdLocal(target.id);
          if (savedCwd) setCwd(savedCwd);
        }
      }
    }).catch(console.error);
  }, [setSelectedAssistant, setCwd]);

  useEffect(() => {
    loadAssistants();
  }, [loadAssistants]);

  const currentAssistant = useMemo(() => {
    if (!assistants.length) return undefined;
    if (!selectedAssistantId) return assistants[0];
    return assistants.find((item) => item.id === selectedAssistantId) ?? assistants[0];
  }, [assistants, selectedAssistantId]);

  const filteredSessions = useMemo(() => {
    if (!currentAssistant) {
      return sessionList.filter((session) => !session.assistantId);
    }
    return sessionList.filter((session) => session.assistantId === currentAssistant.id);
  }, [sessionList, currentAssistant]);

  useEffect(() => {
    setCopied(false);
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, [resumeSessionId]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const handleCopyCommand = async () => {
    if (!resumeSessionId) return;
    const command = `claude --resume ${resumeSessionId}`;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return;
    }
    setCopied(true);
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      setResumeSessionId(null);
    }, 3000);
  };

  const handleSelectAssistant = (assistant?: AssistantConfig) => {
    if (!assistant) return;
    setSelectedAssistant(assistant.id, assistant.skillNames ?? [], assistant.provider, assistant.model, assistant.persona);
    // 切换助理时从 localStorage 恢复该助理的工作区（没有则清空）
    const savedCwd = loadAssistantCwdLocal(assistant.id);
    setCwd(savedCwd);
    // 自动定位到该助理最新的一个会话（sessionList 已按 updatedAt 降序排列）
    const latestSession = sessionList.find((s) => s.assistantId === assistant.id);
    setActiveSessionId(latestSession?.id ?? null);
    // 若该助理没有保存工作区，提示用户先选择工作区
    if (!savedCwd) {
      onNoWorkspace?.();
    }
  };

  const getAssistantInitial = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return "?";
    return trimmed.slice(0, 1).toUpperCase();
  };

  return (
    <aside
      className="fixed inset-y-0 left-0 flex h-full flex-col border-r border-ink-900/5 bg-[#FAF9F6] pb-4 pt-12"
      style={{ width: `${width}px` }}
    >
      <div
        className="absolute top-0 left-0 right-0 h-12"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[74px] flex-col border-r border-ink-900/5 px-2 py-3">
          <div className="flex flex-col items-center gap-3">
            {assistants.length === 0 && (
              <div className="mt-3 text-[10px] text-muted">No AI</div>
            )}
            {assistants.map((assistant) => {
              const selected = currentAssistant?.id === assistant.id;
              return (
                <button
                  key={assistant.id}
                  type="button"
                  onClick={() => handleSelectAssistant(assistant)}
                  title={assistant.name}
                  className={`flex h-11 w-11 items-center justify-center rounded-full border text-sm font-semibold transition ${
                    selected
                      ? "border-accent bg-accent/10 text-accent shadow-sm"
                      : "border-ink-900/10 bg-surface text-ink-700 hover:border-ink-900/20 hover:bg-surface-tertiary"
                  }`}
                >
                  {getAssistantInitial(assistant.name)}
                </button>
              );
            })}
          </div>

          <div className="mt-auto border-t border-ink-900/5 pt-2 grid gap-1">
            <button
              onClick={() => setShowAssistantManager(true)}
              title="助理管理"
              className="flex h-10 w-full items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </button>
            <button
              onClick={() => setShowScheduler(true)}
              title="定时任务"
              className="flex h-10 w-full items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </button>
            {onOpenSkill && (
              <button
                onClick={onOpenSkill}
                title="Skills"
                className="flex h-10 w-full items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </button>
            )}
            {onOpenMcp && (
              <button
                onClick={onOpenMcp}
                title="MCP 服务器"
                className="flex h-10 w-full items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 1v6m0 6v10M1 12h6m6 0h10" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setShowSettings(true)}
              title="设置"
              className="flex h-10 w-full items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2.5">
          <div className="pb-2 pt-3">
            <div className="mb-2 truncate px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-light">
              {currentAssistant?.name ?? "未归类会话"}
            </div>
            <button
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-medium text-white shadow-soft transition-all hover:bg-accent-hover active:scale-[0.98]"
              onClick={() => {
                if (currentAssistant) {
                  handleSelectAssistant(currentAssistant);
                }
                onNewSession();
              }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New Task
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2 gap-0.5 pt-1 pr-1">
            {filteredSessions.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink-900/5">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                    <path d="M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </div>
                <p className="text-xs text-muted">暂无任务</p>
              </div>
            )}

            {filteredSessions.map((session) => {
              const isActive = activeSessionId === session.id;
              const isRunning = session.status === "running";
              const isError = session.status === "error";
              const isCompleted = session.status === "completed";
              return (
              <div
                key={session.id}
                className={`group relative cursor-pointer rounded-xl px-3 py-2.5 text-left transition-all ${
                  isActive
                    ? "bg-accent/8 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]"
                    : "hover:bg-ink-900/4"
                }`}
                onClick={() => setActiveSessionId(session.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveSessionId(session.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="flex items-start gap-2">
                  {/* 状态指示点 */}
                  <div className="mt-1 flex-shrink-0">
                    {isRunning ? (
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-75" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-info" />
                      </span>
                    ) : (
                      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${
                        isActive ? "bg-accent" : isCompleted ? "bg-success/60" : isError ? "bg-error/60" : "bg-ink-900/15"
                      }`} />
                    )}
                  </div>

                  {/* 内容 */}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate text-[12.5px] font-medium leading-snug ${
                      isRunning ? "text-info" : isError ? "text-error" : isActive ? "text-ink-900" : "text-ink-700"
                    }`}>
                      {session.title || "未命名任务"}
                    </span>
                    {session.cwd && (
                      <span className="mt-0.5 truncate text-[10.5px] text-muted-light">
                        {formatCwd(session.cwd)}
                      </span>
                    )}
                  </div>

                  {/* 菜单按钮：默认隐藏，hover/active 时显示 */}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        className={`flex-shrink-0 rounded-lg p-1 transition-all ${
                          isActive
                            ? "text-ink-400 hover:bg-ink-900/8 hover:text-ink-600"
                            : "text-transparent group-hover:text-ink-400 hover:bg-ink-900/8 hover:text-ink-600"
                        }`}
                        aria-label="Open session menu"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                          <circle cx="5" cy="12" r="1.6" />
                          <circle cx="12" cy="12" r="1.6" />
                          <circle cx="19" cy="12" r="1.6" />
                        </svg>
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="z-50 min-w-[200px] rounded-xl border border-ink-900/8 bg-white p-1 shadow-elevated" align="end" sideOffset={4}>
                        <DropdownMenu.Item className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-700 outline-none hover:bg-ink-900/5" onSelect={() => onDeleteSession(session.id)}>
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-error/70" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M7 7l1 12a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9l1-12" />
                          </svg>
                          删除任务
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-700 outline-none hover:bg-ink-900/5" onSelect={() => setResumeSessionId(session.id)}>
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <path d="M4 5h16v14H4z" /><path d="M7 9h10M7 12h6" /><path d="M13 15l3 2-3 2" />
                          </svg>
                          在 Claude Code 中恢复
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
            );})}

          </div>
        </div>
      </div>

      <Dialog.Root open={!!resumeSessionId} onOpenChange={(open) => !open && setResumeSessionId(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-ink-900/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <Dialog.Title className="text-lg font-semibold text-ink-800">Resume</Dialog.Title>
              <Dialog.Close asChild>
                <button className="rounded-full p-1 text-ink-500 hover:bg-ink-900/10" aria-label="Close dialog">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 6l12 12M18 6l-12 12" />
                  </svg>
                </button>
              </Dialog.Close>
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-ink-900/10 bg-surface px-3 py-2 font-mono text-xs text-ink-700">
              <span className="flex-1 break-all">{resumeSessionId ? `claude --resume ${resumeSessionId}` : ""}</span>
              <button className="rounded-lg p-1.5 text-ink-600 hover:bg-ink-900/10" onClick={handleCopyCommand} aria-label="Copy resume command">
                {copied ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12l4 4L19 6" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                )}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <SettingsModal open={showSettings} onOpenChange={setShowSettings} />

      <AssistantManagerModal
        open={showAssistantManager}
        onOpenChange={setShowAssistantManager}
        onAssistantsChanged={loadAssistants}
      />

      <SchedulerModal open={showScheduler} onOpenChange={setShowScheduler} />

      <div
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-accent/20"
        onMouseDown={onResizeStart}
      />
    </aside>
  );
}
