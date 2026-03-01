import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientEvent } from "../types";

const COLLAPSED_HEIGHT = 128;
const EXPANDED_HEIGHT = 380;

export function QuickWindow() {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState<string | null>(null);
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);

  // Skill state
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([]);
  const [activeSkill, setActiveSkill] = useState<SkillInfo | null>(null);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [skillSelectedIndex, setSkillSelectedIndex] = useState(0);
  const [slashTriggered, setSlashTriggered] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const skillBtnRef = useRef<HTMLButtonElement>(null);
  const skillFilterRef = useRef<HTMLInputElement>(null);

  const selectedAssistant = assistants.find((a) => a.id === selectedAssistantId);

  const assistantSkillNames = selectedAssistant?.skillNames ?? [];
  const availableSkills = allSkills.filter(
    (s) => assistantSkillNames.length === 0 || assistantSkillNames.includes(s.name)
  );
  const filteredSkills = availableSkills.filter((s) => {
    const f = skillFilter.toLowerCase();
    return s.name.toLowerCase().includes(f) || (s.description || "").toLowerCase().includes(f);
  });

  useEffect(() => {
    window.electron.getAssistantsConfig().then((c) => {
      setAssistants(c.assistants ?? []);
      if (c.defaultAssistantId) setSelectedAssistantId(c.defaultAssistantId);
      else if (c.assistants?.length > 0) setSelectedAssistantId(c.assistants[0].id);
    }).catch(console.error);

    window.electron.getClaudeConfig().then((config) => {
      setAllSkills(config.skills ?? []);
    }).catch(console.error);
  }, []);

  useEffect(() => {
    const unsub = window.electron.onQuickWindowShow(() => {
      setPrompt("");
      setSending(false);
      setShowAssistantPicker(false);
      closeSkillPicker();
      setActiveSkill(null);
      setSlashTriggered(false);

      // Sync with main window's selected assistant
      try {
        const saved = localStorage.getItem("vk-cowork-selected-assistant");
        if (saved && assistants.some((a) => a.id === saved)) {
          setSelectedAssistantId(saved);
        }
      } catch {}

      setTimeout(() => inputRef.current?.focus(), 50);
    });
    inputRef.current?.focus();
    return unsub;
  }, [assistants]);

  useEffect(() => {
    if (!showAssistantPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowAssistantPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAssistantPicker]);

  useEffect(() => {
    if (!showSkillPicker) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !skillPickerRef.current?.contains(target) &&
        !skillBtnRef.current?.contains(target)
      ) {
        closeSkillPicker();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSkillPicker]);

  // Detect `/` slash command in prompt
  useEffect(() => {
    const trimmed = prompt.trimStart();
    if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
      const filter = trimmed.slice(1);
      setSkillFilter(filter);
      setSkillSelectedIndex(0);
      if (!showSkillPicker) {
        setSlashTriggered(true);
        openSkillPicker();
      }
    } else if (slashTriggered && showSkillPicker && !trimmed.startsWith("/")) {
      closeSkillPicker();
      setSlashTriggered(false);
    }
  }, [prompt]);

  useEffect(() => {
    setActiveSkill(null);
  }, [selectedAssistantId]);

  function openSkillPicker() {
    setShowSkillPicker(true);
    setSkillFilter("");
    setSkillSelectedIndex(0);
    setShowAssistantPicker(false);
    window.electron.resizeQuickWindow(EXPANDED_HEIGHT);
    setTimeout(() => skillFilterRef.current?.focus(), 80);
  }

  function closeSkillPicker() {
    setShowSkillPicker(false);
    setSkillFilter("");
    setSlashTriggered(false);
    window.electron.resizeQuickWindow(COLLAPSED_HEIGHT);
  }

  function handleSelectSkill(skill: SkillInfo) {
    setActiveSkill(skill);
    const trimmed = prompt.trimStart();
    if (trimmed.startsWith("/")) {
      setPrompt("");
    }
    closeSkillPicker();
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleClearSkill() {
    setActiveSkill(null);
    inputRef.current?.focus();
  }

  const sendEvent = useCallback((event: ClientEvent) => {
    window.electron.sendClientEvent(event);
  }, []);

  const handleSend = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sending) return;

    setSending(true);
    const assistant = assistants.find((a) => a.id === selectedAssistantId);

    let title = text.slice(0, 50).trim() || "Quick Chat";
    try {
      title = await window.electron.generateSessionTitle(text);
    } catch { /* fallback */ }

    const skillNames = activeSkill
      ? [activeSkill.name]
      : assistant?.skillNames?.length
        ? assistant.skillNames
        : undefined;

    sendEvent({
      type: "session.start",
      payload: {
        title,
        prompt: text,
        cwd: assistant?.defaultCwd || undefined,
        allowedTools: "Read,Edit,Bash",
        provider: assistant?.provider || "claude",
        ...(assistant?.model ? { model: assistant.model } : {}),
        ...(selectedAssistantId ? { assistantId: selectedAssistantId } : {}),
        ...(assistant?.persona ? { assistantPersona: assistant.persona } : {}),
        ...(skillNames ? { assistantSkillNames: skillNames } : {}),
      },
    });

    setPrompt("");
    setSending(false);
    setActiveSkill(null);
    window.electron.showMainWindow();
  }, [prompt, sending, sendEvent, assistants, selectedAssistantId, activeSkill]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSkillPicker && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillSelectedIndex((i) => (i + 1) % filteredSkills.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillSelectedIndex((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        handleSelectSkill(filteredSkills[skillSelectedIndex]);
        return;
      }
    }

    if (e.key === "Escape") {
      if (showSkillPicker) {
        closeSkillPicker();
        inputRef.current?.focus();
      } else if (showAssistantPicker) {
        setShowAssistantPicker(false);
      } else {
        window.electron.hideQuickWindow();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (showSkillPicker && filteredSkills.length > 0) {
        handleSelectSkill(filteredSkills[skillSelectedIndex]);
      } else {
        handleSend();
      }
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-cream select-none overflow-hidden rounded-xl">
      {/* Input area — always at the top */}
      <div className="flex flex-col shrink-0">
        {/* Top: brand + input */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-2">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "#2C5F2F" }}
          >
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>

          <span className="text-[13px] font-semibold text-ink-800 shrink-0">AI Team</span>

          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="你想让我做什么..."
            rows={1}
            disabled={sending}
            className="flex-1 resize-none bg-transparent text-[14px] text-ink-800 placeholder:text-muted-light focus:outline-none disabled:opacity-50 leading-relaxed"
            style={{ maxHeight: 64, minHeight: 22 }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 64) + "px";
            }}
          />

          <div className="flex items-center shrink-0">
            <span className="text-[11px] text-muted-light whitespace-nowrap">
              {sending ? "发送中..." : "⏎ 发送 · / 技能"}
            </span>
          </div>
        </div>

        {/* Divider */}
        <div className="mx-5 h-px bg-ink-900/8" />

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-5 py-2.5">
          <div className="flex items-center gap-1.5" ref={pickerRef}>
            {/* Assistant button */}
            <button
              onClick={() => { setShowAssistantPicker((v) => !v); if (showSkillPicker) closeSkillPicker(); }}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[12px] font-medium transition-colors ${
                showAssistantPicker
                  ? "bg-surface-tertiary text-ink-800"
                  : "text-muted hover:bg-surface-secondary hover:text-ink-700"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span className="max-w-[80px] truncate">{selectedAssistant?.name || "默认助理"}</span>
              <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 opacity-50" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {/* Inline assistant picker */}
            {showAssistantPicker && assistants.length > 0 && (
              <div className="flex items-center gap-1">
                {assistants.map((a) => {
                  const isActive = a.id === selectedAssistantId;
                  return (
                    <button
                      key={a.id}
                      onClick={() => {
                        setSelectedAssistantId(a.id);
                        setShowAssistantPicker(false);
                        inputRef.current?.focus();
                      }}
                      className={`rounded-lg px-2.5 py-[5px] text-[11px] font-medium transition-colors ${
                        isActive
                          ? "bg-accent/10 text-accent border border-accent/20"
                          : "text-muted hover:bg-surface-secondary hover:text-ink-700 border border-transparent"
                      }`}
                    >
                      {a.name}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Skill button */}
            {!showAssistantPicker && (
              activeSkill ? (
                <div className="flex items-center gap-1 rounded-lg bg-accent/10 pl-2 pr-1 py-[4px] text-[11px] font-medium text-accent max-w-[130px]">
                  <svg viewBox="0 0 24 24" className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18h6M10 22h4M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/>
                  </svg>
                  <span className="truncate">{activeSkill.name}</span>
                  <button
                    onClick={handleClearSkill}
                    className="flex-shrink-0 flex h-4 w-4 items-center justify-center rounded-full hover:bg-accent/20 text-accent/60 hover:text-accent transition-colors"
                  >
                    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                  </button>
                </div>
              ) : availableSkills.length > 0 ? (
                <button
                  ref={skillBtnRef}
                  onClick={() => { showSkillPicker ? closeSkillPicker() : openSkillPicker(); }}
                  className={`flex items-center gap-1 rounded-lg px-2.5 py-[5px] text-[11px] font-medium transition-colors ${
                    showSkillPicker
                      ? "bg-accent/10 text-accent"
                      : "text-muted hover:bg-surface-secondary hover:text-ink-700"
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 18h6M10 22h4M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/>
                  </svg>
                  技能
                </button>
              ) : null
            )}

            {/* Provider badge */}
            {!showAssistantPicker && (
              <div className="flex items-center gap-1.5 rounded-lg px-2.5 py-[5px] bg-surface-secondary text-[11px] font-medium text-muted">
                <div className="h-1.5 w-1.5 rounded-full bg-success" />
                {selectedAssistant?.provider === "codex" ? "Codex" : "Claude"}
              </div>
            )}
          </div>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!prompt.trim() || sending}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-white transition-all disabled:opacity-25"
            style={{ background: "#2C5F2F" }}
          >
            {sending ? (
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Skill picker — expands downward below the toolbar */}
      {showSkillPicker && (
        <div ref={skillPickerRef} className="flex-1 flex flex-col min-h-0 border-t border-ink-900/5">
          {/* Search */}
          <div className="px-4 pt-2.5 pb-2">
            <div className="flex items-center gap-2 rounded-lg bg-white border border-ink-900/8 px-2.5 py-1.5">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={skillFilterRef}
                type="text"
                placeholder="搜索技能，按 ESC 退出"
                value={skillFilter}
                onChange={(e) => { setSkillFilter(e.target.value); setSkillSelectedIndex(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSkillSelectedIndex((i) => (i + 1) % Math.max(1, filteredSkills.length));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSkillSelectedIndex((i) => (i - 1 + Math.max(1, filteredSkills.length)) % Math.max(1, filteredSkills.length));
                  } else if (e.key === "Enter" && filteredSkills[skillSelectedIndex]) {
                    e.preventDefault();
                    handleSelectSkill(filteredSkills[skillSelectedIndex]);
                  } else if (e.key === "Escape") {
                    closeSkillPicker();
                    inputRef.current?.focus();
                  }
                }}
                className="flex-1 bg-transparent text-xs text-ink-800 placeholder:text-muted focus:outline-none"
              />
            </div>
          </div>

          {/* Skill list */}
          {filteredSkills.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-xs text-muted">{allSkills.length === 0 ? "暂无可用技能" : "没有匹配的技能"}</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto py-0.5">
              {filteredSkills.map((skill, index) => (
                <button
                  key={skill.name}
                  className={`w-full px-4 py-2 text-left flex items-center gap-2.5 transition-colors ${
                    index === skillSelectedIndex ? "bg-accent/8" : "hover:bg-ink-900/[0.03]"
                  }`}
                  onClick={() => handleSelectSkill(skill)}
                  onMouseEnter={() => setSkillSelectedIndex(index)}
                >
                  <div className={`flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0 ${
                    index === skillSelectedIndex ? "bg-accent/15 text-accent" : "bg-ink-900/[0.06] text-ink-500"
                  }`}>
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M9 18h6M10 22h4M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/>
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs font-medium truncate ${index === skillSelectedIndex ? "text-accent" : "text-ink-800"}`}>
                      {skill.name}
                    </div>
                    {skill.description && (
                      <div className="text-[10px] text-muted truncate leading-tight mt-0.5">{skill.description}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
