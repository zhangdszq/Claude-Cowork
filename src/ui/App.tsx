import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { useIPC } from "./hooks/useIPC";
import { useAppStore } from "./store/useAppStore";
import type { ServerEvent } from "./types";
import { Sidebar } from "./components/Sidebar";
import { PromptInput, usePromptActions } from "./components/PromptInput";
import { MessageCard, ProcessGroup } from "./components/EventCard";
import { MessageSkeleton } from "./components/MessageSkeleton";
import { McpSkillModal } from "./components/McpSkillModal";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { SplashScreen } from "./components/SplashScreen";
import { DecisionPanel } from "./components/DecisionPanel";
import { ChapterSelector, parseChapters, isChapterSelectionText } from "./components/ChapterSelector";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { TitleBar, usePlatform } from "./components/TitleBar";
import MDContent from "./render/markdown";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

import appIconUrl from "./assets/app-icon.png";
import splash1 from "../../assets/splash-1.jpg";

const ONBOARDING_COMPLETE_KEY = "vk-cowork-onboarding-complete";
const SPLASH_SEEN_KEY = "vk-cowork-splash-seen";
const ASSISTANT_CWDS_KEY = "vk-cowork-assistant-cwds";

function ThinkingDots() {
  return (
    <span className="inline-flex gap-[2px] ml-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-[3px] h-[3px] rounded-full bg-current opacity-60"
          style={{ animation: `thinking-dot 1.2s ease-in-out ${i * 0.2}s infinite` }}
        />
      ))}
    </span>
  );
}

// ─── Per-assistant workspace persistence (localStorage) ───────────────────────
function getAssistantCwds(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(ASSISTANT_CWDS_KEY) || "{}"); }
  catch { return {}; }
}
function saveAssistantCwdLocal(assistantId: string, cwd: string) {
  const map = getAssistantCwds();
  map[assistantId] = cwd;
  localStorage.setItem(ASSISTANT_CWDS_KEY, JSON.stringify(map));
}
function loadAssistantCwdLocal(assistantId: string | null): string {
  if (!assistantId) return "";
  return getAssistantCwds()[assistantId] ?? "";
}

// ─── WorkspaceDropdown ────────────────────────────────────────────────────────
interface WorkspaceDropdownProps {
  currentCwd: string;
  onSelect: (path: string) => void;
  onBrowse: () => void;
}

function WorkspaceDropdown({ currentCwd, onSelect, onBrowse }: WorkspaceDropdownProps) {
  const [recentCwds, setRecentCwds] = useState<string[]>([]);

  useEffect(() => {
    window.electron.getRecentCwds(8).then(setRecentCwds).catch(console.error);
  }, []);

  const formatPath = (path: string) => {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || path;
  };

  const getPathParent = (path: string) => {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 1) return path;
    return "/" + parts.slice(0, -1).join("/");
  };

  return (
    <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-ink-900/10 bg-white shadow-elevated overflow-hidden">
      {recentCwds.length > 0 ? (
        <div className="py-1.5">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-light">
            最近使用
          </div>
          {recentCwds.slice(0, 6).map((path) => {
            const isActive = currentCwd === path;
            return (
              <button
                key={path}
                onClick={() => onSelect(path)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  isActive ? "bg-accent/8" : "hover:bg-surface-secondary"
                }`}
              >
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                  isActive ? "bg-accent/15" : "bg-surface-tertiary"
                }`}>
                  <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${isActive ? "text-accent" : "text-muted"}`} fill="none" stroke="currentColor" strokeWidth="1.75">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-medium truncate ${isActive ? "text-accent" : "text-ink-800"}`}>
                    {formatPath(path)}
                  </div>
                  <div className="text-[10px] text-muted-light truncate">{getPathParent(path)}</div>
                </div>
                {isActive && (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="px-3 py-4 text-center text-xs text-muted">暂无最近工作区</div>
      )}
      <div className="border-t border-ink-900/8 p-1.5">
        <button
          onClick={onBrowse}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-ink-700 hover:bg-surface-secondary transition-colors"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          浏览其他目录...
        </button>
      </div>
    </div>
  );
}
const SIDEBAR_WIDTH_KEY = "vk-cowork-sidebar-width";
const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_SIDEBAR_WIDTH = 340;
const WORKSPACE_PANEL_WIDTH = 320;

// 按 session 存储的 partialMessage 状态
type SessionPartialState = {
  content: string;
  isVisible: boolean;
};

// ─── 消息分组：把连续的工具调用/结果归入"过程组" ──────────────────────────────
import type { StreamMessage } from "./types";

type MessageGroup =
  | { type: "single"; message: StreamMessage; key: string }
  | { type: "process"; messages: StreamMessage[]; key: string };

function isProcessMessage(msg: StreamMessage): boolean {
  const m = msg as any;
  if (m.type === "user_prompt" || m.type === "skill_loaded") return false;
  if (m.type === "system" || m.type === "result") return false;
  // stream_event messages are intermediate SSE chunks — treat as process so they
  // don't split consecutive tool-call/thinking groups into multiple ProcessGroups
  if (m.type === "stream_event") return true;
  if (m.type === "assistant") {
    const content: any[] = m.message?.content ?? [];
    const hasText = content.some((c: any) => c.type === "text");
    const hasToolUse = content.some((c: any) => c.type === "tool_use");
    const hasThinking = content.some((c: any) => c.type === "thinking");
    // tool calls or pure thinking (no final text) → process
    return hasToolUse || (hasThinking && !hasText);
  }
  if (m.type === "user") {
    const content = m.message?.content;
    return Array.isArray(content) && content.some((c: any) => c.type === "tool_result");
  }
  return false;
}

function groupMessages(messages: StreamMessage[]): MessageGroup[] {
  const result: MessageGroup[] = [];
  let bucket: StreamMessage[] = [];
  let bucketStart = 0;

  messages.forEach((msg, idx) => {
    if (isProcessMessage(msg)) {
      if (bucket.length === 0) bucketStart = idx;
      bucket.push(msg);
    } else {
      if (bucket.length > 0) {
        result.push({ type: "process", messages: bucket, key: `proc-${bucketStart}` });
        bucket = [];
      }
      const key = ("uuid" in msg && msg.uuid) ? String(msg.uuid) : `msg-${idx}`;
      result.push({ type: "single", message: msg, key });
    }
  });

  if (bucket.length > 0) {
    result.push({ type: "process", messages: bucket, key: `proc-${bucketStart}` });
  }

  return result;
}

// ─── Google Login Screen ─────────────────────────────────────────────────────

function GoogleLoginScreen({ onLoggedIn, onSkip }: { onLoggedIn: () => void; onSkip: () => void }) {
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoggingIn(true);
    setError(null);
    try {
      const result = await window.electron.googleLogin();
      if (result.success) {
        onLoggedIn();
      } else {
        setError(result.error || "登录失败");
      }
    } catch (err) {
      setError("登录过程出错: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <div className="flex flex-col h-screen">
      <TitleBar />
      <div className="relative flex-1 overflow-hidden">
        {/* Background image */}
        <img
          src={splash1}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Frosted overlay */}
        <div className="absolute inset-0 bg-white/30 backdrop-blur-[2px]" />

        {/* Centered login card */}
        <div className="relative z-10 flex h-full items-center justify-center p-8">
          <div className="w-full max-w-[380px] rounded-3xl bg-white/90 backdrop-blur-md border border-white/60 px-10 py-12" style={{ boxShadow: "0 0 40px 20px rgba(255,255,255,0.5), 0 8px 32px rgba(0,0,0,0.1)" }}>
            <div className="text-center mb-9">
              <img
                src={appIconUrl}
                alt="AI Team"
                className="w-[68px] h-[68px] mx-auto mb-5 rounded-2xl shadow-card"
              />
              <h1 className="text-2xl font-bold tracking-tight text-ink-800">AI Team</h1>
              <p className="text-sm text-muted mt-2 leading-relaxed">
                请使用 Google 账号登录以继续
              </p>
            </div>

            <div className="space-y-3">
              <button
                onClick={handleLogin}
                disabled={loggingIn}
                className="w-full flex items-center justify-center gap-3 rounded-2xl border border-ink-900/8 bg-white px-5 py-3.5 text-[15px] font-medium text-ink-800 shadow-card hover:shadow-elevated hover:border-ink-900/15 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loggingIn ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    <span>正在等待浏览器授权...</span>
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    <span>使用 Google 登录</span>
                  </>
                )}
              </button>

              <button
                onClick={onSkip}
                className="w-full text-center text-[13px] text-muted hover:text-ink-700 transition-colors py-2"
              >
                跳过登录
              </button>

              {error && (
                <div className="rounded-xl border border-error/20 bg-error/5 p-3.5">
                  <p className="text-xs text-error flex items-start gap-2 leading-relaxed">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                    <span>{error}</span>
                  </p>
                </div>
              )}
            </div>

            <p className="text-center text-[11px] text-ink-400/50 mt-8">
              AI Team · 你的智能协作伙伴
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  
  // Splash screen state — shown once per cold start (flag cleared in main.tsx on boot)
  const [showSplash, setShowSplash] = useState(() => {
    return !localStorage.getItem(SPLASH_SEEN_KEY);
  });

  // Onboarding state
  const [showOnboarding, setShowOnboarding] = useState(() => {
    return !localStorage.getItem(ONBOARDING_COMPLETE_KEY);
  });
  const [onboardingInitialStep, setOnboardingInitialStep] = useState<"welcome" | "codex">("welcome");

  // 启动时检查已有配置，决定是否跳过或从哪一步开始引导
  useEffect(() => {
    if (!showOnboarding) return;
    window.electron.getUserSettings().then((settings) => {
      const hasAnthropic = !!settings.anthropicAuthToken;
      const hasCodex = !!settings.openaiTokens?.accessToken;
      if (hasAnthropic && hasCodex) {
        // 两个都配置了，完全跳过
        localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
        setShowOnboarding(false);
      } else if (hasAnthropic) {
        // 已有 Anthropic Token，直接从 Codex 步骤开始
        setOnboardingInitialStep("codex");
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOnboardingComplete = useCallback(() => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setShowOnboarding(false);
  }, []);

  const handleSplashComplete = useCallback(() => {
    localStorage.setItem(SPLASH_SEEN_KEY, "true");
    setShowSplash(false);
  }, []);

  // Google login gate — null = still checking, true = logged in, false = needs login
  const [googleAuthed, setGoogleAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    window.electron.googleAuthStatus()
      .then((status) => setGoogleAuthed(status.loggedIn))
      .catch(() => setGoogleAuthed(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  
  // 使用 Map 按 sessionId 存储每个 session 的 partial message 状态
  const partialMessagesRef = useRef<Map<string, string>>(new Map());
  const [partialMessages, setPartialMessages] = useState<Map<string, SessionPartialState>>(new Map());

  // 跟踪每个 session 当前流式块是否为 thinking 类型
  const isThinkingBlockRef = useRef<Map<string, boolean>>(new Map());

  // 打字机模拟：用于 Codex 等非流式后端
  const [animatingMsgUuid, setAnimatingMsgUuid] = useState<string | null>(null);
  const typewriterIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typewriterPosRef = useRef(0);

  // 组件卸载时清理打字机定时器
  useEffect(() => {
    return () => {
      if (typewriterIntervalRef.current) clearInterval(typewriterIntervalRef.current);
    };
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!Number.isFinite(raw)) return DEFAULT_SIDEBAR_WIDTH;
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, raw));
  });
  const [inputAreaHeight, setInputAreaHeight] = useState(160);
  const [taskPanelVisible, setTaskPanelVisible] = useState(() => {
    return localStorage.getItem("vk-cowork-task-panel-visible") === "true";
  });
  const handleToggleTaskPanel = useCallback(() => {
    setTaskPanelVisible((prev) => {
      const next = !prev;
      localStorage.setItem("vk-cowork-task-panel-visible", String(next));
      return next;
    });
  }, []);

  const [effectiveSidebarWidth, setEffectiveSidebarWidth] = useState(() => {
    const taskVisible = localStorage.getItem("vk-cowork-task-panel-visible") === "true";
    if (!taskVisible) return 168;
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!Number.isFinite(raw)) return DEFAULT_SIDEBAR_WIDTH;
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, raw));
  });

  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const showStartModal = useAppStore((s) => s.showStartModal);
  const setShowStartModal = useAppStore((s) => s.setShowStartModal);
  const globalError = useAppStore((s) => s.globalError);
  const setGlobalError = useAppStore((s) => s.setGlobalError);
  const historyRequested = useAppStore((s) => s.historyRequested);
  const markHistoryRequested = useAppStore((s) => s.markHistoryRequested);
  const resolvePermissionRequest = useAppStore((s) => s.resolvePermissionRequest);
  const handleServerEvent = useAppStore((s) => s.handleServerEvent);
  const cwd = useAppStore((s) => s.cwd);
  const setCwd = useAppStore((s) => s.setCwd);
  const showSystemInfo = useAppStore((s) => s.showSystemInfo);

  // User display name from personalization settings
  const [userName, setUserName] = useState("User");
  useEffect(() => {
    window.electron.getUserSettings().then((s) => {
      if (s.userName?.trim()) setUserName(s.userName.trim());
    }).catch(() => {});
  }, []);

  // Assistants list for resolving assistant names
  const [assistantsList, setAssistantsList] = useState<AssistantConfig[]>([]);
  const refreshAssistantsList = useCallback(() => {
    window.electron.getAssistantsConfig().then((c) => setAssistantsList(c.assistants ?? [])).catch(console.error);
  }, []);
  useEffect(() => {
    refreshAssistantsList();
  }, [refreshAssistantsList]);

  // Save defaultCwd for the currently selected assistant
  const saveAssistantDefaultCwd = useCallback(async (path: string) => {
    const currentId = useAppStore.getState().selectedAssistantId;
    if (!currentId) return;
    const updated = assistantsList.map((a) =>
      a.id === currentId ? { ...a, defaultCwd: path } : a
    );
    if (!updated.some((a) => a.id === currentId)) return;
    try {
      const saved = await window.electron.saveAssistantsConfig({
        assistants: updated,
        defaultAssistantId: updated[0]?.id,
      });
      setAssistantsList(saved.assistants);
    } catch (err) {
      console.error("Failed to save defaultCwd:", err);
    }
  }, [assistantsList]);

  // Helper function to extract partial message content
  const getPartialMessageContent = (eventMessage: any) => {
    try {
      const realType = eventMessage.delta.type.split("_")[0];
      return eventMessage.delta[realType];
    } catch (error) {
      console.error(error);
      return "";
    }
  };

  // 更新指定 session 的 partial message
  // forceFlush=true 用于 Claude streaming（IPC 事件可能被 React 18 批处理，需要强制刷新）
  // forceFlush=false 用于打字机模拟（setInterval tick 已是独立事件循环，无需强制刷新）
  const updatePartialMessage = useCallback((sessionId: string, content: string, isVisible: boolean, forceFlush = false) => {
    if (forceFlush) {
      flushSync(() => {
        setPartialMessages(prev => {
          const next = new Map(prev);
          next.set(sessionId, { content, isVisible });
          return next;
        });
      });
    } else {
      setPartialMessages(prev => {
        const next = new Map(prev);
        next.set(sessionId, { content, isVisible });
        return next;
      });
    }
  }, []);

  // Clear partial message for a session
  const clearPartialMessage = useCallback((sessionId: string) => {
    partialMessagesRef.current.delete(sessionId);
    setPartialMessages(prev => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  // Handle partial messages from stream events - 按 session 隔离
  const handlePartialMessages = useCallback((partialEvent: ServerEvent) => {
    // 会话结束时停止所有动画并清理
    if (partialEvent.type === "session.status") {
      const { sessionId, status } = partialEvent.payload;
      if (status !== "running") {
        if (typewriterIntervalRef.current) {
          clearInterval(typewriterIntervalRef.current);
          typewriterIntervalRef.current = null;
        }
        setAnimatingMsgUuid(null);
        clearPartialMessage(sessionId);
      }
      return;
    }

    if (partialEvent.type !== "stream.message") return;

    const sessionId = partialEvent.payload.sessionId;
    const message = partialEvent.payload.message as any;

    // ── Claude 原生流式（stream_event / content_block_delta）──────────────────
    if (message.type === "stream_event") {
      if (message.event.type === "content_block_start") {
        const blockType = message.event.content_block?.type;
        const isThinking = blockType === "thinking";
        isThinkingBlockRef.current.set(sessionId, isThinking);
        partialMessagesRef.current.set(sessionId, "");
        if (!isThinking) {
          updatePartialMessage(sessionId, "", true, true);
          isUserScrolledUpRef.current = false;
        }
      }
      if (message.event.type === "content_block_delta") {
        const isThinking = isThinkingBlockRef.current.get(sessionId) ?? false;
        const currentContent = partialMessagesRef.current.get(sessionId) || "";
        const newContent = currentContent + (getPartialMessageContent(message.event) || "");
        partialMessagesRef.current.set(sessionId, newContent);
        if (!isThinking) {
          updatePartialMessage(sessionId, newContent, true, true);
        }
      }
      if (message.event.type === "content_block_stop") {
        const isThinking = isThinkingBlockRef.current.get(sessionId) ?? false;
        isThinkingBlockRef.current.delete(sessionId);
        if (!isThinking) {
          const finalContent = partialMessagesRef.current.get(sessionId) || "";
          updatePartialMessage(sessionId, finalContent, false, true);
          setTimeout(() => clearPartialMessage(sessionId), 500);
        } else {
          partialMessagesRef.current.delete(sessionId);
        }
      }
      return;
    }

    // ── Codex / 其他非流式后端：收到完整文本消息后模拟打字机 ──────────────────
    if (message.type === "assistant" && message.uuid) {
      const content: any[] = message.message?.content ?? [];
      const textItem = content.find((c: any) => c.type === "text");
      // 只对有实质内容的文本消息做打字机（短文本直接展示）
      if (textItem?.text && textItem.text.length > 8) {
        const fullText: string = textItem.text;
        const msgUuid: string = message.uuid;

        // 停止上一次动画
        if (typewriterIntervalRef.current) {
          clearInterval(typewriterIntervalRef.current);
          typewriterIntervalRef.current = null;
        }

        typewriterPosRef.current = 0;
        setAnimatingMsgUuid(msgUuid);
        updatePartialMessage(sessionId, "", true);
        isUserScrolledUpRef.current = false;

        // 每帧展示若干字符，约 60fps × 4字符 = ~240字/秒
        const CHARS_PER_TICK = 4;
        typewriterIntervalRef.current = setInterval(() => {
          typewriterPosRef.current += CHARS_PER_TICK;
          if (typewriterPosRef.current >= fullText.length) {
            clearInterval(typewriterIntervalRef.current!);
            typewriterIntervalRef.current = null;
            setAnimatingMsgUuid(null);
            clearPartialMessage(sessionId);
          } else {
            updatePartialMessage(sessionId, fullText.slice(0, typewriterPosRef.current), true);
          }
        }, 16);
      }
    }
  }, [updatePartialMessage, clearPartialMessage, setAnimatingMsgUuid]);

  // Combined event handler
  const onEvent = useCallback((event: ServerEvent) => {
    handleServerEvent(event);
    handlePartialMessages(event);
  }, [handleServerEvent, handlePartialMessages]);

  const { connected, sendEvent } = useIPC(onEvent);
  const { handleStartFromModal } = usePromptActions(sendEvent);

  // Listen for quick-window session start — switch assistant & set pendingStart
  useEffect(() => {
    const unsubscribe = window.electron.onQuickWindowSession((data) => {
      console.log("[QuickWindow] received quick-window-session in main renderer:", data);
      if (data.assistantId) {
        const assistant = assistantsList.find((a) => a.id === data.assistantId);
        if (assistant) {
          console.log("[QuickWindow] switching to assistant:", assistant.name);
          useAppStore.getState().setSelectedAssistant(
            assistant.id,
            assistant.skillNames ?? [],
            assistant.provider,
            assistant.model,
            assistant.persona,
            assistant.skillTags ?? [],
          );
        } else {
          console.log("[QuickWindow] assistant not found in list, id:", data.assistantId);
        }
      }
      useAppStore.getState().setPendingStart(true);
    });
    return unsubscribe;
  }, [assistantsList]);

  // Listen for scheduler task execution events
  useEffect(() => {
    const unsubscribe = window.electron.onSchedulerRunTask((task) => {
      console.log("[Scheduler] Running task:", task);
      // Start a new session with the scheduled task
      // Use task.cwd, or current cwd state, or fallback to a default
      const effectiveCwd = task.cwd || cwd || "/Users";
      handleStartFromModal({
        prompt: task.prompt,
        cwd: effectiveCwd,
        title: `定时任务: ${task.name}`,
        assistantId: task.assistantId,
      });
    });
    return unsubscribe;
  }, [handleStartFromModal, cwd]);

  // Send DingTalk notification when a scheduled-task session completes
  const prevSessionStatusRef = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const [sessionId, session] of Object.entries(sessions)) {
      const prevStatus = prevSessionStatusRef.current[sessionId];
      const curStatus = session.status;

      if (
        prevStatus === "running" &&
        curStatus !== "running" &&
        session.title?.startsWith("定时任务:") &&
        session.assistantId
      ) {
        // Extract last assistant text as notification body
        const lastAssistant = [...session.messages]
          .reverse()
          .find((m: any) => m.type === "assistant") as any;
        const resultText: string =
          lastAssistant?.message?.content
            ?.filter((c: any) => c.type === "text")
            ?.map((c: any) => c.text as string)
            ?.join("\n")
            ?.trim() || "任务已完成";

        const taskName = session.title.replace(/^定时任务:\s*/, "");
        const statusLabel = curStatus === "error" ? "执行出错" : "执行完成";
        const notifyText = `**📋 定时任务${statusLabel}：${taskName}**\n\n${resultText}`;

        window.electron.sendProactiveDingtalk({
          assistantId: session.assistantId,
          text: notifyText,
          title: `定时任务${statusLabel}: ${taskName}`,
        }).catch((err: unknown) => {
          console.error("[Scheduler] Failed to send DingTalk notification:", err);
        });
      }

      prevSessionStatusRef.current[sessionId] = curStatus;
    }
  }, [sessions]);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const messages = activeSession?.messages ?? [];
  const permissionRequests = activeSession?.permissionRequests ?? [];
  const isRunning = activeSession?.status === "running";
  const activeAssistantName = useMemo(() => {
    const aid = activeSession?.assistantId;
    if (!aid) return undefined;
    return assistantsList.find((a) => a.id === aid)?.name;
  }, [activeSession?.assistantId, assistantsList]);

  // Check if the last assistant message contains chapter selection prompt
  // Only show if user hasn't replied yet
  const chapterSelectionInfo = useMemo(() => {
    if (isRunning) return null; // Don't show while running
    if (messages.length === 0) return null;
    
    // Find the last assistant message with chapter selection
    let chapterMsgIndex = -1;
    let chapterText = '';
    let chapters: Array<{ id: string; time: string; title: string }> = [];
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && 'type' in msg && msg.type === 'assistant') {
        const assistantMsg = msg as SDKAssistantMessage;
        const textContent = assistantMsg.message?.content?.find(
          (c: any) => c.type === 'text'
        );
        if (textContent && 'text' in textContent) {
          const text = textContent.text as string;
          
          if (isChapterSelectionText(text)) {
            const parsedChapters = parseChapters(text);
            if (parsedChapters.length > 0) {
              chapterMsgIndex = i;
              chapterText = text;
              chapters = parsedChapters;
              break;
            }
          }
        }
      }
    }
    
    // If no chapter selection message found, return null
    if (chapterMsgIndex === -1) return null;
    
    // Check if there's a user reply after the chapter selection message
    for (let i = chapterMsgIndex + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (msg && 'type' in msg && msg.type === 'user_prompt') {
        // User has already replied, don't show selector
        return null;
      }
    }
    
    return { text: chapterText, chapters };
  }, [messages, isRunning]);

  // Handle chapter selection
  const handleChapterSelection = useCallback((selectedIds: string[]) => {
    if (!activeSessionId) return;
    const response = selectedIds.join(", ");
    // Send as a new user message to continue the conversation
    sendEvent({
      type: "session.continue",
      payload: {
        sessionId: activeSessionId,
        prompt: response
      }
    });
  }, [activeSessionId, sendEvent]);

  // Handle AskUserQuestion answer (when SDK doesn't provide proper permission.request)
  const handleAskUserQuestionAnswer = useCallback((toolUseId: string, answers: Record<string, string>) => {
    if (!activeSessionId) return;
    
    // Format answers as a readable response
    const response = Object.entries(answers)
      .map(([q, a]) => `${q}: ${a}`)
      .join("\n");
    
    console.log('[App] AskUserQuestion answered:', toolUseId, answers);
    
    // Send as a new user message to continue the conversation
    sendEvent({
      type: "session.continue",
      payload: {
        sessionId: activeSessionId,
        prompt: response
      }
    });
  }, [activeSessionId, sendEvent]);
  
  // 判断是否正在加载历史消息
  const isLoadingHistory = activeSession && !activeSession.hydrated;
  
  // 获取当前 session 的 partial message 状态
  const currentPartialState = activeSessionId ? partialMessages.get(activeSessionId) : undefined;
  const partialMessage = currentPartialState?.content ?? "";
  const showPartialMessage = currentPartialState?.isVisible ?? false;

  useEffect(() => {
    if (connected) sendEvent({ type: "session.list" });
  }, [connected, sendEvent]);

  useEffect(() => {
    if (!activeSessionId || !connected) return;
    const session = sessions[activeSessionId];
    if (session && !session.hydrated && !historyRequested.has(activeSessionId)) {
      markHistoryRequested(activeSessionId);
      sendEvent({ type: "session.history", payload: { sessionId: activeSessionId } });
    }
  }, [activeSessionId, connected, sessions, historyRequested, markHistoryRequested, sendEvent]);

  // 检测用户是否在底部附近（100px 阈值）
  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const threshold = 100;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }, []);

  // 监听滚动事件，检测用户是否手动滚动离开底部
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      isUserScrolledUpRef.current = !isNearBottom();
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [isNearBottom]);

  // 节流滚动，避免流式输出时频繁触发
  // 只有在用户没有手动滚动离开底部时才自动滚动
  const scrollTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    // 如果用户手动滚动到上方，不要自动滚动
    if (isUserScrolledUpRef.current) return;

    if (scrollTimeoutRef.current) {
      window.clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = window.setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50); // 50ms 节流
    
    return () => {
      if (scrollTimeoutRef.current) {
        window.clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [messages, partialMessage]);

  // When input area grows, scroll to keep last message above it
  useEffect(() => {
    if (!isUserScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [inputAreaHeight]);

  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [showChangeWorkspacePicker, setShowChangeWorkspacePicker] = useState(false);
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const [showWorkspacePanel, setShowWorkspacePanel] = useState(false);

  const handleNewSession = useCallback(() => {
    useAppStore.getState().setActiveSessionId(null);
    const assistantId = useAppStore.getState().selectedAssistantId;
    const savedCwd = loadAssistantCwdLocal(assistantId);
    if (savedCwd) {
      // 助理已记住过工作区，直接进入对话
      useAppStore.getState().setCwd(savedCwd);
      setShowWorkspacePicker(false);
    } else {
      setShowWorkspacePicker(true);
    }
  }, []);

  // 统一的工作区选择回调：保存到 localStorage + 更新 store
  const handleWorkspaceSelect = useCallback((path: string) => {
    setCwd(path);
    setShowWorkspacePicker(false);
    setShowChangeWorkspacePicker(false);
    const assistantId = useAppStore.getState().selectedAssistantId;
    if (assistantId) {
      saveAssistantCwdLocal(assistantId, path);
    }
    // 异步同步到 assistant config（可选，不影响主流程）
    saveAssistantDefaultCwd(path);
  }, [saveAssistantDefaultCwd, setCwd]);

  // 点击历史任务时关闭工作区选择器
  useEffect(() => {
    if (activeSessionId) {
      setShowWorkspacePicker(false);
    }
  }, [activeSessionId]);

  // 无 session 时（初始化或清空后），用 WorkspacePicker 替代 NewTask 弹框
  useEffect(() => {
    if (showStartModal) {
      setShowStartModal(false);
      handleNewSession();
    }
  }, [showStartModal, setShowStartModal, handleNewSession]);

  const handleDeleteSession = useCallback((sessionId: string) => {
    sendEvent({ type: "session.delete", payload: { sessionId } });
  }, [sendEvent]);

  // MCP/Skill modal state
  const [mcpSkillModalOpen, setMcpSkillModalOpen] = useState(false);
  const [mcpSkillInitialTab, setMcpSkillInitialTab] = useState<"mcp" | "skill">("mcp");

  // Header compact mode: hide button labels when header is narrow
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerCompact, setHeaderCompact] = useState(false);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setHeaderCompact(entry.contentRect.width < 480);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleOpenMcp = useCallback(() => {
    setMcpSkillInitialTab("mcp");
    setMcpSkillModalOpen(true);
  }, []);

  const handleOpenSkill = useCallback(() => {
    setMcpSkillInitialTab("skill");
    setMcpSkillModalOpen(true);
  }, []);

  const handlePermissionResult = useCallback((toolUseId: string, result: PermissionResult) => {
    if (!activeSessionId) return;
    sendEvent({ type: "permission.response", payload: { sessionId: activeSessionId, toolUseId, result } });
    resolvePermissionRequest(activeSessionId, toolUseId);
  }, [activeSessionId, sendEvent, resolvePermissionRequest]);

  const handleSidebarResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = startWidth + (moveEvent.clientX - startX);
      const clamped = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, nextWidth));
      setSidebarWidth(clamped);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  // Must be called before any conditional return to satisfy React hooks rules
  const platform = usePlatform();
  const titleBarH = platform !== "darwin" ? 32 : 0;

  // Show onboarding wizard for new users
  if (showOnboarding) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} initialStep={onboardingInitialStep} />;
  }

  // Show splash screen on first launch (after onboarding)
  if (showSplash) {
    return <SplashScreen onComplete={handleSplashComplete} />;
  }

  // Google login gate
  if (googleAuthed === null) {
    return (
      <div className="flex flex-col h-screen bg-surface-cream">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center">
          <svg className="h-6 w-6 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    );
  }
  if (googleAuthed === false) {
    return <GoogleLoginScreen onLoggedIn={() => setGoogleAuthed(true)} onSkip={() => setGoogleAuthed(true)} />;
  }

  return (
    <div className="flex flex-col h-screen bg-surface-cream">
      <TitleBar />
      <div className="flex flex-1 min-h-0 relative">
      <Sidebar
        connected={connected}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        width={sidebarWidth}
        onResizeStart={handleSidebarResizeStart}
        onOpenSkill={handleOpenSkill}
        onOpenMcp={handleOpenMcp}
        onNoWorkspace={() => setShowWorkspacePicker(true)}
        taskPanelVisible={taskPanelVisible}
        onToggleTaskPanel={handleToggleTaskPanel}
        onEffectiveWidthChange={setEffectiveSidebarWidth}
        onShowSplash={() => setShowSplash(true)}
        titleBarHeight={titleBarH}
      />

      <main
        className="flex flex-1 flex-col bg-surface-cream"
        style={{
          marginLeft: `${effectiveSidebarWidth}px`,
          marginRight: showWorkspacePanel ? `${WORKSPACE_PANEL_WIDTH}px` : 0,
          transition: "margin-left 0.2s ease, margin-right 0.2s ease",
        }}
      >
        <div
          ref={headerRef}
          className="flex items-center justify-between h-12 border-b border-ink-900/10 bg-surface-cream select-none px-4"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="w-24 shrink-0" /> {/* Spacer for balance */}
          <span className="min-w-0 flex-1 text-center text-sm font-medium text-ink-700 truncate px-2">
            {activeSession?.title || "AI Team"}
          </span>
          <div className="flex items-center gap-1 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {/* New task */}
            <button
              onClick={handleNewSession}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
              title="新任务"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {!headerCompact && <span>新任务</span>}
            </button>
            <div className="h-4 w-px bg-ink-900/10" />
            {/* Workspace button */}
            <div className="relative">
              <button
                onClick={() => setWorkspaceDropdownOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors max-w-[180px]"
                title="工作区"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
                {!headerCompact && (
                  <>
                    <span className="truncate">
                      {cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "选择工作区"}
                    </span>
                    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </>
                )}
              </button>

              {workspaceDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setWorkspaceDropdownOpen(false)}
                  />
                  <WorkspaceDropdown
                    currentCwd={cwd}
                    onSelect={(path) => {
                      setWorkspaceDropdownOpen(false);
                      handleWorkspaceSelect(path);
                    }}
                    onBrowse={() => {
                      setWorkspaceDropdownOpen(false);
                      setShowChangeWorkspacePicker(true);
                    }}
                  />
                </>
              )}
            </div>

            {/* Workspace panel toggle button */}
            <button
              onClick={() => setShowWorkspacePanel((v) => !v)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                showWorkspacePanel
                  ? "bg-accent/10 text-accent"
                  : "text-muted hover:bg-surface-tertiary hover:text-ink-700"
              }`}
              title="工作区产出"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M15 3v18" />
                <path d="M9 9h3M9 12h3M9 15h3" />
              </svg>
              {!headerCompact && <span>工作区</span>}
            </button>
          </div>
        </div>

        {showWorkspacePicker ? (
          <WorkspacePicker
            currentCwd={cwd}
            onSelect={handleWorkspaceSelect}
          />
        ) : null}

        {showChangeWorkspacePicker ? (
          <div className="absolute inset-0 z-30 flex flex-col bg-surface-cream" style={{ top: "48px" }}>
            <div className="flex items-center gap-2 px-4 pt-4 pb-2 border-b border-ink-900/8">
              <button
                onClick={() => setShowChangeWorkspacePicker(false)}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="text-sm font-medium text-ink-800">切换工作区</span>
            </div>
            <WorkspacePicker
              currentCwd={cwd}
              onSelect={handleWorkspaceSelect}
            />
          </div>
        ) : null}

        <div ref={scrollContainerRef} className={`flex-1 px-8 pt-6 ${(messages.length > 0 || isLoadingHistory) ? "overflow-y-auto" : "overflow-hidden"} ${showWorkspacePicker || showChangeWorkspacePicker ? "hidden" : ""}`} style={{ paddingBottom: (messages.length > 0 || isLoadingHistory) ? `${inputAreaHeight + 16}px` : 0 }}>
          <div className="mx-auto max-w-3xl">
            {isLoadingHistory ? (
              // 骨架屏 - 加载历史消息时显示
              <MessageSkeleton />
            ) : messages.length === 0 ? null : (
              // 打字机动画进行时，从列表中隐藏正在被动画展示的消息（避免重复显示）
              groupMessages(
                (animatingMsgUuid
                  ? messages.filter(msg => (msg as any).uuid !== animatingMsgUuid)
                  : messages
                ).filter(msg => (msg as any).type !== "stream_event")
              ).map((group, gIdx, arr) => {
                const isLastGroup = gIdx === arr.length - 1;
                if (group.type === "process") {
                  return (
                    <ProcessGroup
                      key={group.key}
                      messages={group.messages}
                      isLast={isLastGroup}
                      isRunning={isRunning}
                      showSystemInfo={false}
                      onAskUserQuestionAnswer={handleAskUserQuestionAnswer}
                      assistantName={activeAssistantName}
                      userName={userName}
                    />
                  );
                }
                return (
                  <MessageCard
                    key={group.key}
                    message={group.message}
                    isLast={isLastGroup}
                    isRunning={isRunning}
                    showSystemInfo={showSystemInfo}
                    onAskUserQuestionAnswer={handleAskUserQuestionAnswer}
                    assistantName={activeAssistantName}
                    userName={userName}
                  />
                );
              })
            )}

            {/* Loading skeleton - show when running but no response yet */}
            {isRunning && !showPartialMessage && (
              <div className="mt-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                  </div>
                  <span className="text-xs text-muted">思考中<ThinkingDots /></span>
                </div>
                <div className="flex flex-col gap-2 px-1">
                  <div className="relative h-3 w-2/12 overflow-hidden rounded-full bg-ink-900/10">
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                  </div>
                  <div className="relative h-3 w-full overflow-hidden rounded-full bg-ink-900/10">
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                  </div>
                  <div className="relative h-3 w-3/4 overflow-hidden rounded-full bg-ink-900/10">
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                  </div>
                </div>
              </div>
            )}

            {/* Streaming content - typewriter display when active */}
            {showPartialMessage && (
              <div className="partial-message">
                <MDContent text={partialMessage} />
                <span className="inline-block w-[2px] h-[1em] bg-ink-400 animate-pulse ml-0.5 align-middle translate-y-[0.05em]" />
              </div>
            )}

            {/* Chapter selector - shown when assistant asks to select chapters */}
            {chapterSelectionInfo && !isRunning && (
              <ChapterSelector
                chapters={chapterSelectionInfo.chapters}
                onSubmit={handleChapterSelection}
              />
            )}

            {/* AskUserQuestion panel - shown when there's a pending question */}
            {(() => {
              const askUserRequests = permissionRequests.filter(req => req.toolName === "AskUserQuestion");
              console.log('[App] permissionRequests:', permissionRequests);
              console.log('[App] AskUserQuestion requests:', askUserRequests);
              return askUserRequests.map(req => (
                <div key={req.toolUseId} className="mt-4">
                  <DecisionPanel
                    request={req}
                    onSubmit={(result) => handlePermissionResult(req.toolUseId, result)}
                  />
                </div>
              ));
            })()}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {!showWorkspacePicker && !showChangeWorkspacePicker && <PromptInput sendEvent={sendEvent} sidebarWidth={effectiveSidebarWidth} rightPanelWidth={showWorkspacePanel ? WORKSPACE_PANEL_WIDTH : 0} onHeightChange={setInputAreaHeight} />}
      </main>

      {globalError && (
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-error/20 bg-error-light px-4 py-3 shadow-lg">
          <div className="flex items-center gap-3">
            <span className="text-sm text-error">{globalError}</span>
            <button className="text-error hover:text-error/80" onClick={() => setGlobalError(null)}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
      )}

      <McpSkillModal
        open={mcpSkillModalOpen}
        onOpenChange={setMcpSkillModalOpen}
        initialTab={mcpSkillInitialTab}
      />

      {/* Workspace Panel - right sidebar */}
      {showWorkspacePanel && (
        <div
          className="fixed right-0 bottom-0 border-l border-ink-900/10 overflow-hidden"
          style={{ top: `${titleBarH}px`, width: `${WORKSPACE_PANEL_WIDTH}px`, zIndex: 20 }}
        >
          <WorkspacePanel
            onClose={() => setShowWorkspacePanel(false)}
          />
        </div>
      )}
      </div>
    </div>
  );
}

export default App;
