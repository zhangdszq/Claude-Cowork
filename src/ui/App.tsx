import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { useIPC } from "./hooks/useIPC";
import { useAppStore } from "./store/useAppStore";
import type { ServerEvent } from "./types";
import { Sidebar } from "./components/Sidebar";
import { StartSessionModal } from "./components/StartSessionModal";
import { PromptInput, usePromptActions } from "./components/PromptInput";
import { MessageCard } from "./components/EventCard";
import { MessageSkeleton } from "./components/MessageSkeleton";
import { McpSkillModal } from "./components/McpSkillModal";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { DecisionPanel } from "./components/DecisionPanel";
import { ChapterSelector, parseChapters, isChapterSelectionText } from "./components/ChapterSelector";
import { SchedulerModal } from "./components/SchedulerModal";
import MDContent from "./render/markdown";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

const ONBOARDING_COMPLETE_KEY = "vk-cowork-onboarding-complete";

// 按 session 存储的 partialMessage 状态
type SessionPartialState = {
  content: string;
  isVisible: boolean;
};

function App() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  
  // Onboarding state
  const [showOnboarding, setShowOnboarding] = useState(() => {
    // Check if onboarding was completed before
    return !localStorage.getItem(ONBOARDING_COMPLETE_KEY);
  });

  const handleOnboardingComplete = useCallback(() => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setShowOnboarding(false);
  }, []);
  
  // 使用 Map 按 sessionId 存储每个 session 的 partial message 状态
  const partialMessagesRef = useRef<Map<string, string>>(new Map());
  const [partialMessages, setPartialMessages] = useState<Map<string, SessionPartialState>>(new Map());

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
  const prompt = useAppStore((s) => s.prompt);
  const setPrompt = useAppStore((s) => s.setPrompt);
  const cwd = useAppStore((s) => s.cwd);
  const setCwd = useAppStore((s) => s.setCwd);
  const pendingStart = useAppStore((s) => s.pendingStart);
  const showSystemInfo = useAppStore((s) => s.showSystemInfo);
  const setShowSystemInfo = useAppStore((s) => s.setShowSystemInfo);

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
  const updatePartialMessage = useCallback((sessionId: string, content: string, isVisible: boolean) => {
    setPartialMessages(prev => {
      const next = new Map(prev);
      next.set(sessionId, { content, isVisible });
      return next;
    });
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
    // Clear partial message when session stops (status changes to non-running)
    if (partialEvent.type === "session.status") {
      const { sessionId, status } = partialEvent.payload;
      if (status !== "running") {
        clearPartialMessage(sessionId);
      }
      return;
    }

    if (partialEvent.type !== "stream.message" || partialEvent.payload.message.type !== "stream_event") return;

    const sessionId = partialEvent.payload.sessionId;
    const message = partialEvent.payload.message as any;
    
    if (message.event.type === "content_block_start") {
      partialMessagesRef.current.set(sessionId, "");
      updatePartialMessage(sessionId, "", true);
      // 新的流式输出开始时，重置滚动状态，恢复自动滚动
      isUserScrolledUpRef.current = false;
    }

    if (message.event.type === "content_block_delta") {
      const currentContent = partialMessagesRef.current.get(sessionId) || "";
      const newContent = currentContent + (getPartialMessageContent(message.event) || "");
      partialMessagesRef.current.set(sessionId, newContent);
      updatePartialMessage(sessionId, newContent, true);
    }

    if (message.event.type === "content_block_stop") {
      const finalContent = partialMessagesRef.current.get(sessionId) || "";
      updatePartialMessage(sessionId, finalContent, false);
      // 延迟清理
      setTimeout(() => {
        clearPartialMessage(sessionId);
      }, 500);
    }
  }, [updatePartialMessage, clearPartialMessage]);

  // Combined event handler
  const onEvent = useCallback((event: ServerEvent) => {
    handleServerEvent(event);
    handlePartialMessages(event);
  }, [handleServerEvent, handlePartialMessages]);

  const { connected, sendEvent } = useIPC(onEvent);
  const { handleStartFromModal } = usePromptActions(sendEvent);

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
      });
    });
    return unsubscribe;
  }, [handleStartFromModal, cwd]);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const messages = activeSession?.messages ?? [];
  const permissionRequests = activeSession?.permissionRequests ?? [];
  const isRunning = activeSession?.status === "running";

  // Check if the last assistant message contains chapter selection prompt
  // Only show if user hasn't replied yet
  const chapterSelectionInfo = useMemo(() => {
    if (isRunning) return null; // Don't show while running
    if (messages.length === 0) return null;
    
    // Find the last assistant message with chapter selection
    let chapterMsgIndex = -1;
    let chapterText = '';
    let chapters: Array<{ id: string; number: string; time: string; title: string }> = [];
    
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

  const handleNewSession = useCallback(() => {
    useAppStore.getState().setActiveSessionId(null);
    setShowStartModal(true);
  }, [setShowStartModal]);

  const handleDeleteSession = useCallback((sessionId: string) => {
    sendEvent({ type: "session.delete", payload: { sessionId } });
  }, [sendEvent]);

  // MCP/Skill modal state
  const [mcpSkillModalOpen, setMcpSkillModalOpen] = useState(false);
  const [mcpSkillInitialTab, setMcpSkillInitialTab] = useState<"mcp" | "skill">("mcp");

  // Scheduler modal state
  const [schedulerModalOpen, setSchedulerModalOpen] = useState(false);

  const handleOpenMcp = useCallback(() => {
    setMcpSkillInitialTab("mcp");
    setMcpSkillModalOpen(true);
  }, []);

  const handleOpenSkill = useCallback(() => {
    setMcpSkillInitialTab("skill");
    setMcpSkillModalOpen(true);
  }, []);

  const handleOpenScheduler = useCallback(() => {
    setSchedulerModalOpen(true);
  }, []);

  const handlePermissionResult = useCallback((toolUseId: string, result: PermissionResult) => {
    if (!activeSessionId) return;
    sendEvent({ type: "permission.response", payload: { sessionId: activeSessionId, toolUseId, result } });
    resolvePermissionRequest(activeSessionId, toolUseId);
  }, [activeSessionId, sendEvent, resolvePermissionRequest]);

  // Show onboarding wizard for new users
  if (showOnboarding) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} />;
  }

  return (
    <div className="flex h-screen bg-surface">
      <Sidebar
        connected={connected}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
      />

      <main className="flex flex-1 flex-col ml-[280px] bg-surface-cream">
        <div 
          className="flex items-center justify-between h-12 border-b border-ink-900/10 bg-surface-cream select-none px-4"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="w-24" /> {/* Spacer for balance */}
          <span className="text-sm font-medium text-ink-700">{activeSession?.title || "VK Cowork"}</span>
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <button
              onClick={() => setShowSystemInfo(!showSystemInfo)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                showSystemInfo 
                  ? "bg-accent/10 text-accent" 
                  : "text-muted hover:bg-surface-tertiary hover:text-ink-700"
              }`}
              title={showSystemInfo ? "隐藏系统信息" : "显示系统信息"}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              {showSystemInfo ? "隐藏详情" : "显示详情"}
            </button>
            <button
              onClick={handleOpenMcp}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
              title="MCP 服务器"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v6m0 6v10M1 12h6m6 0h10" />
              </svg>
              MCP
            </button>
            <button
              onClick={handleOpenSkill}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
              title="Skills"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              SKILL
            </button>
            <button
              onClick={handleOpenScheduler}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
              title="定时任务"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              定时
            </button>
          </div>
        </div>

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 pb-40 pt-6">
          <div className="mx-auto max-w-3xl">
            {isLoadingHistory ? (
              // 骨架屏 - 加载历史消息时显示
              <MessageSkeleton />
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-lg font-medium text-ink-700">No messages yet</div>
                <p className="mt-2 text-sm text-muted">Start a conversation with Claude Code</p>
              </div>
            ) : (
              messages.map((msg, idx) => {
                // 使用消息的唯一标识作为 key，避免不必要的重新渲染
                const msgKey = ('uuid' in msg && msg.uuid) ? String(msg.uuid) : `msg-${idx}`;
                return (
                  <MessageCard
                    key={msgKey}
                    message={msg}
                    isLast={idx === messages.length - 1}
                    isRunning={isRunning}
                    showSystemInfo={showSystemInfo}
                    onAskUserQuestionAnswer={handleAskUserQuestionAnswer}
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
                  <span className="text-xs text-muted">思考中...</span>
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

            {/* Partial message display with skeleton loading - show when streaming is active */}
            {showPartialMessage && (
              <div className="partial-message">
                <MDContent text={partialMessage} />
                <div className="mt-3 flex flex-col gap-2 px-1">
                  <div className="relative h-3 w-2/12 overflow-hidden rounded-full bg-ink-900/10">
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                  </div>
                  <div className="relative h-3 w-full overflow-hidden rounded-full bg-ink-900/10">
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                  </div>
                  <div className="relative h-3 w-full overflow-hidden rounded-full bg-ink-900/10">
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                  </div>
                  <div className="relative h-3 w-full overflow-hidden rounded-full bg-ink-900/10">
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                  </div>
                  <div className="relative h-3 w-4/12 overflow-hidden rounded-full bg-ink-900/10">
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ink-900/30 to-transparent animate-shimmer" />
                  </div>
                </div>
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

        <PromptInput sendEvent={sendEvent} />
      </main>

      {showStartModal && (
        <StartSessionModal
          cwd={cwd}
          prompt={prompt}
          pendingStart={pendingStart}
          onCwdChange={setCwd}
          onPromptChange={setPrompt}
          onStart={handleStartFromModal}
          onClose={() => setShowStartModal(false)}
        />
      )}

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

      <SchedulerModal
        open={schedulerModalOpen}
        onOpenChange={setSchedulerModalOpen}
      />
    </div>
  );
}

export default App;
