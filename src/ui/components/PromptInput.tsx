import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientEvent } from "../types";
import { useAppStore } from "../store/useAppStore";

const DEFAULT_ALLOWED_TOOLS = "Read,Edit,Bash";
const MAX_ROWS = 12;
const LINE_HEIGHT = 21;
const MAX_HEIGHT = MAX_ROWS * LINE_HEIGHT;

// Skill category config
const SKILL_CATEGORY_CONFIG: Record<string, { icon: string; color: string }> = {
  "development": { icon: "code", color: "text-blue-500 bg-blue-500/10" },
  "writing": { icon: "pen", color: "text-purple-500 bg-purple-500/10" },
  "analysis": { icon: "chart", color: "text-green-500 bg-green-500/10" },
  "design": { icon: "palette", color: "text-pink-500 bg-pink-500/10" },
  "productivity": { icon: "zap", color: "text-yellow-500 bg-yellow-500/10" },
  "research": { icon: "search", color: "text-cyan-500 bg-cyan-500/10" },
  "other": { icon: "box", color: "text-gray-500 bg-gray-500/10" },
};

// Get category from skill name/description
function getSkillCategory(skill: SkillInfo): string {
  const name = skill.name.toLowerCase();
  const desc = (skill.description || "").toLowerCase();
  const text = name + " " + desc;
  
  if (text.includes("code") || text.includes("dev") || text.includes("程序") || text.includes("开发") || text.includes("debug")) {
    return "development";
  }
  if (text.includes("write") || text.includes("写作") || text.includes("文档") || text.includes("blog") || text.includes("article")) {
    return "writing";
  }
  if (text.includes("data") || text.includes("分析") || text.includes("chart") || text.includes("数据") || text.includes("report")) {
    return "analysis";
  }
  if (text.includes("design") || text.includes("设计") || text.includes("ui") || text.includes("ux") || text.includes("创意")) {
    return "design";
  }
  if (text.includes("效率") || text.includes("productivity") || text.includes("automat") || text.includes("自动")) {
    return "productivity";
  }
  if (text.includes("research") || text.includes("调研") || text.includes("搜索") || text.includes("search")) {
    return "research";
  }
  return "other";
}

// Skill icon component
function SkillIcon({ type, className = "" }: { type: string; className?: string }) {
  switch (type) {
    case "code":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case "pen":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
        </svg>
      );
    case "chart":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      );
    case "palette":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="13.5" cy="6.5" r="1.5" />
          <circle cx="17.5" cy="10.5" r="1.5" />
          <circle cx="8.5" cy="7.5" r="1.5" />
          <circle cx="6.5" cy="12.5" r="1.5" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" />
        </svg>
      );
    case "zap":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "search":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        </svg>
      );
  }
}

interface PromptInputProps {
  sendEvent: (event: ClientEvent) => void;
}

export function usePromptActions(sendEvent: (event: ClientEvent) => void) {
  const prompt = useAppStore((state) => state.prompt);
  const cwd = useAppStore((state) => state.cwd);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const setPrompt = useAppStore((state) => state.setPrompt);
  const setPendingStart = useAppStore((state) => state.setPendingStart);
  const setGlobalError = useAppStore((state) => state.setGlobalError);
  const provider = useAppStore((state) => state.provider);
  const codexModel = useAppStore((state) => state.codexModel);

  // Image attachment - only store path, Agent will use built-in analyze_image tool
  const [imagePath, setImagePath] = useState<string | null>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const isRunning = activeSession?.status === "running";

  // Handle image selection
  const handleSelectImage = useCallback(async () => {
    try {
      const path = await window.electron.selectImage();
      if (path) {
        setImagePath(path);
      }
    } catch (error) {
      console.error("Failed to select image:", error);
      setGlobalError("Failed to select image.");
    }
  }, [setGlobalError]);

  const handleRemoveImage = useCallback(() => {
    setImagePath(null);
  }, []);

  // Handle pasted image
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        try {
          // Convert file to base64
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              // Remove data:image/xxx;base64, prefix
              resolve(dataUrl.split(",")[1]);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          // Save to temp file and get path
          const path = await window.electron.savePastedImage(base64, item.type);
          if (path) {
            setImagePath(path);
          }
        } catch (error) {
          console.error("Failed to handle pasted image:", error);
          setGlobalError("Failed to paste image.");
        }
        break;
      }
    }
  }, [setGlobalError]);

  const handleSend = useCallback(async () => {
    if (!prompt.trim() && !imagePath) return;

    // Build prompt with image path if attached
    let finalPrompt = prompt.trim();
    
    if (imagePath) {
      // Include image path in prompt - Agent will use built-in analyze_image tool
      const imageInstruction = `请分析这张图片: ${imagePath}`;
      if (finalPrompt) {
        finalPrompt = `${imageInstruction}\n\n${finalPrompt}`;
      } else {
        finalPrompt = imageInstruction;
      }
      setImagePath(null);
    }

    // Determine if we need a new session:
    // 1. No active session
    // 2. Active session's provider differs from selected provider
    const activeProvider = activeSession?.provider ?? "claude";
    const needNewSession = !activeSessionId || (activeProvider !== provider);

    if (needNewSession) {
      let title = "";
      try {
        setPendingStart(true);
        title = await window.electron.generateSessionTitle(finalPrompt);
      } catch (error) {
        console.error(error);
        setPendingStart(false);
        setGlobalError("Failed to get session title.");
        return;
      }
      sendEvent({
        type: "session.start",
        payload: {
          title,
          prompt: finalPrompt,
          cwd: cwd.trim() || undefined,
          allowedTools: DEFAULT_ALLOWED_TOOLS,
          provider,
          ...(provider === "codex" ? { model: codexModel } : {}),
        }
      });
    } else {
      if (activeSession?.status === "running") {
        setGlobalError("Session is still running. Please wait for it to finish.");
        return;
      }
      sendEvent({ type: "session.continue", payload: { sessionId: activeSessionId, prompt: finalPrompt } });
    }
    setPrompt("");
  }, [activeSession, activeSessionId, cwd, imagePath, prompt, provider, codexModel, sendEvent, setGlobalError, setPendingStart, setPrompt]);

  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    sendEvent({ type: "session.stop", payload: { sessionId: activeSessionId } });
  }, [activeSessionId, sendEvent]);

  // handleStartFromModal can be called with optional params (for scheduled tasks)
  const handleStartFromModal = useCallback((params?: { prompt?: string; cwd?: string; title?: string }) => {
    const effectiveCwd = params?.cwd || cwd.trim();
    const effectivePrompt = params?.prompt || prompt.trim();
    const effectiveTitle = params?.title;
    
    if (!effectiveCwd) {
      setGlobalError("Working Directory is required to start a session.");
      return;
    }
    
    if (!effectivePrompt) {
      setGlobalError("Prompt is required to start a session.");
      return;
    }
    
    // If params provided, directly start session (for scheduled tasks)
    if (params?.prompt) {
      setPendingStart(true);
      sendEvent({
        type: "session.start",
        payload: { 
          title: effectiveTitle || "定时任务", 
          prompt: effectivePrompt, 
          cwd: effectiveCwd, 
          allowedTools: DEFAULT_ALLOWED_TOOLS,
          provider,
          ...(provider === "codex" ? { model: codexModel } : {}),
        }
      });
      return;
    }
    
    // Otherwise use normal flow
    handleSend();
  }, [cwd, prompt, handleSend, sendEvent, setGlobalError, setPendingStart]);

  return { 
    prompt, 
    setPrompt, 
    isRunning, 
    imagePath,
    handleSend, 
    handleStop, 
    handleStartFromModal,
    handleSelectImage,
    handleRemoveImage,
    handlePaste
  };
}

export function PromptInput({ sendEvent }: PromptInputProps) {
  const { 
    prompt, 
    setPrompt, 
    isRunning, 
    imagePath,
    handleSend, 
    handleStop,
    handleSelectImage,
    handleRemoveImage,
    handlePaste
  } = usePromptActions(sendEvent);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  // Skills state
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [skillFilter, setSkillFilter] = useState("");
  const skillListRef = useRef<HTMLDivElement | null>(null);

  // Load skills on mount
  useEffect(() => {
    window.electron.getClaudeConfig().then((config) => {
      setSkills(config.skills);
    }).catch(console.error);
  }, []);

  // Filter skills based on input
  const filteredSkills = skills.filter(skill => {
    const filter = skillFilter.toLowerCase().replace(/^\//, "");
    return skill.name.toLowerCase().includes(filter) ||
      (skill.description || "").toLowerCase().includes(filter);
  });

  // Check if we should show skills selector
  useEffect(() => {
    const trimmed = prompt.trimStart();
    // Show skills selector only when:
    // 1. Prompt starts with /
    // 2. No space after the slash command (still typing the command name)
    if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
      const filterPart = trimmed;
      setSkillFilter(filterPart);
      setShowSkills(true);
      setSelectedIndex(0);
    } else {
      setShowSkills(false);
      setSkillFilter("");
    }
  }, [prompt]);

  // Scroll selected item into view
  useEffect(() => {
    if (showSkills && skillListRef.current) {
      const selectedElement = skillListRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex, showSkills]);

  const handleSelectSkill = useCallback(async (skill: SkillInfo) => {
    setShowSkills(false);
    
    // Read full skill content
    try {
      const content = await window.electron.readSkillContent(skill.fullPath);
      if (content) {
        // Get current session ID
        const state = useAppStore.getState();
        const sessionId = state.activeSessionId;
        
        if (sessionId) {
          // Add skill_loaded message to the session
          state.addLocalMessage(sessionId, {
            type: "skill_loaded",
            skillName: skill.name,
            skillContent: content,
            skillDescription: skill.description
          });
        }
        
        // Also set prompt with skill slash command for Claude to use
        setPrompt(`/${skill.name} `);
      } else {
        // Fallback if content couldn't be loaded
        setPrompt(`/${skill.name} `);
      }
    } catch (error) {
      console.error("Failed to load skill content:", error);
      setPrompt(`/${skill.name} `);
    }
    
    promptRef.current?.focus();
  }, [setPrompt]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle skill selection navigation
    if (showSkills && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filteredSkills.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        handleSelectSkill(filteredSkills[selectedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSkills(false);
        return;
      }
    }

    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (isRunning) { handleStop(); return; }
    handleSend();
  };

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    target.style.height = "auto";
    const scrollHeight = target.scrollHeight;
    if (scrollHeight > MAX_HEIGHT) {
      target.style.height = `${MAX_HEIGHT}px`;
      target.style.overflowY = "auto";
    } else {
      target.style.height = `${scrollHeight}px`;
      target.style.overflowY = "hidden";
    }
  };

  useEffect(() => {
    if (!promptRef.current) return;
    promptRef.current.style.height = "auto";
    const scrollHeight = promptRef.current.scrollHeight;
    if (scrollHeight > MAX_HEIGHT) {
      promptRef.current.style.height = `${MAX_HEIGHT}px`;
      promptRef.current.style.overflowY = "auto";
    } else {
      promptRef.current.style.height = `${scrollHeight}px`;
      promptRef.current.style.overflowY = "hidden";
    }
  }, [prompt]);

  // Get filename from path
  const imageFileName = imagePath ? imagePath.split("/").pop() : null;

  return (
    <section className="fixed bottom-0 left-0 right-0 bg-gradient-to-t from-surface via-surface to-transparent pb-6 px-2 lg:pb-8 pt-8 lg:ml-[280px]">
      <div className="mx-auto w-full max-w-full lg:max-w-3xl relative">
        {/* Skills Selector Dropdown */}
        {showSkills && (
          <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-ink-900/10 bg-surface shadow-elevated overflow-hidden z-50">
            {/* Header */}
            <div className="px-4 py-2.5 border-b border-ink-900/5 bg-surface-secondary/50">
              <div className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
                <span className="text-sm font-medium text-ink-800">选择技能</span>
                <span className="text-xs text-muted">输入 / 搜索技能</span>
              </div>
            </div>
            
            {filteredSkills.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <svg viewBox="0 0 24 24" className="h-10 w-10 mx-auto text-muted-light" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
                <p className="mt-2 text-sm text-muted">
                  {skills.length === 0 ? "暂无可用技能" : "没有找到匹配的技能"}
                </p>
                <p className="mt-1 text-xs text-muted-light">
                  在 ~/.claude/skills/ 目录下添加技能
                </p>
              </div>
            ) : (
              <div 
                ref={skillListRef}
                className="max-h-72 overflow-y-auto py-1"
              >
                {filteredSkills.map((skill, index) => {
                  const category = getSkillCategory(skill);
                  const config = SKILL_CATEGORY_CONFIG[category] || SKILL_CATEGORY_CONFIG.other;
                  return (
                    <button
                      key={skill.name}
                      className={`w-full px-4 py-3 text-left flex items-start gap-3 transition-colors ${
                        index === selectedIndex 
                          ? "bg-accent/10" 
                          : "hover:bg-surface-secondary"
                      }`}
                      onClick={() => handleSelectSkill(skill)}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      <div className={`flex h-10 w-10 items-center justify-center rounded-xl flex-shrink-0 ${config.color}`}>
                        <SkillIcon type={config.icon} className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${index === selectedIndex ? "text-accent" : "text-ink-800"}`}>
                            {skill.name}
                          </span>
                          <span className="flex items-center gap-1 text-[10px] text-success">
                            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="currentColor">
                              <circle cx="12" cy="12" r="4" />
                            </svg>
                            已安装
                          </span>
                        </div>
                        <div className="text-xs text-muted mt-1 line-clamp-2">
                          {skill.description || "暂无描述"}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            
            {/* Footer */}
            <div className="border-t border-ink-900/5 px-4 py-2 bg-surface-secondary/50">
              <div className="flex items-center gap-4 text-xs text-muted">
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-surface rounded border border-ink-900/10 font-mono text-[10px]">↑↓</kbd>
                  选择
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-surface rounded border border-ink-900/10 font-mono text-[10px]">Tab</kbd>
                  确认
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-surface rounded border border-ink-900/10 font-mono text-[10px]">Esc</kbd>
                  取消
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Image Preview */}
        {imagePath && (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-ink-900/10 bg-surface-secondary px-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
              <svg className="h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none">
                <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink-700 truncate">{imageFileName}</div>
              <div className="text-xs text-muted">Agent will analyze this image</div>
            </div>
            <button
              onClick={handleRemoveImage}
              className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-ink-900/10 hover:text-ink-700"
              aria-label="Remove image"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}
        
        {/* Input Area */}
        <div className="flex w-full items-end gap-3 rounded-2xl border border-ink-900/10 bg-surface px-4 py-3 shadow-card">
          {/* Image Upload Button */}
          <button
            onClick={handleSelectImage}
            disabled={isRunning}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-ink-900/10 text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Attach image"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path 
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" 
                stroke="currentColor" 
                strokeWidth="1.5" 
                strokeLinecap="round" 
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </button>
          
          <textarea
            rows={1}
            className="flex-1 resize-none bg-transparent py-1.5 text-sm text-ink-800 placeholder:text-muted focus:outline-none"
            placeholder={imagePath ? "Add instructions for the image (optional)..." : "Describe what you want agent to handle... (Cmd+V to paste image)"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            ref={promptRef}
            disabled={isRunning}
          />
          
          <button
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
              isRunning 
                ? "bg-error text-white hover:bg-error/90" 
                : "bg-accent text-white hover:bg-accent-hover"
            }`}
            onClick={isRunning ? handleStop : handleSend}
            aria-label={isRunning ? "Stop session" : "Send prompt"}
          >
            {isRunning ? (
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path d="M3.4 20.6 21 12 3.4 3.4l2.8 7.2L16 12l-9.8 1.4-2.8 7.2Z" fill="currentColor" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
