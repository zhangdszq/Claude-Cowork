import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { BotConfigModal } from "./BotConfigModal";


interface AssistantManagerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssistantsChanged?: () => void;
}

type EditingAssistant = {
  id: string;
  name: string;
  provider: "claude" | "codex";
  model: string;
  skillNames: string[];
  persona: string;
};

function emptyAssistant(): EditingAssistant {
  return {
    id: "",
    name: "",
    provider: "claude",
    model: "",
    skillNames: [],
    persona: "",
  };
}

const CARDS_PER_PAGE = 6;

const AVATAR_COLORS = [
  "bg-violet-100 text-violet-600",
  "bg-blue-100 text-blue-600",
  "bg-emerald-100 text-emerald-600",
  "bg-amber-100 text-amber-600",
  "bg-rose-100 text-rose-600",
  "bg-cyan-100 text-cyan-600",
  "bg-indigo-100 text-indigo-600",
  "bg-teal-100 text-teal-600",
];

function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function AssistantManagerModal({
  open,
  onOpenChange,
  onAssistantsChanged,
}: AssistantManagerModalProps) {
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [editing, setEditing] = useState<EditingAssistant | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [skillSearch, setSkillSearch] = useState("");
  const [botTargetAssistant, setBotTargetAssistant] = useState<AssistantConfig | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [config, claudeConfig] = await Promise.all([
        window.electron.getAssistantsConfig(),
        window.electron.getClaudeConfig(),
      ]);
      setAssistants(config.assistants ?? []);
      setAvailableSkills(claudeConfig.skills ?? []);
    } catch (err) {
      console.error("Failed to load assistants config:", err);
    }
  }, []);

  useEffect(() => {
    if (open) loadData();
  }, [open, loadData]);

  const handleSave = async () => {
    if (!editing || !editing.name.trim()) return;

    const updated: AssistantConfig = {
      id: editing.id || `assistant-${Date.now()}`,
      name: editing.name.trim(),
      provider: editing.provider,
      model: editing.model.trim() || undefined,
      skillNames: editing.skillNames,
      persona: editing.persona.trim() || undefined,
    };

    let nextList: AssistantConfig[];
    if (isNew) {
      nextList = [...assistants, updated];
    } else {
      nextList = assistants.map((item) =>
        item.id === updated.id ? updated : item
      );
    }

    try {
      const saved = await window.electron.saveAssistantsConfig({
        assistants: nextList,
        defaultAssistantId: nextList[0]?.id,
      });
      setAssistants(saved.assistants);
      setEditing(null);
      onAssistantsChanged?.();
    } catch (err) {
      console.error("Failed to save:", err);
    }
  };

  const handleDelete = async (id: string) => {
    const nextList = assistants.filter((item) => item.id !== id);
    try {
      const saved = await window.electron.saveAssistantsConfig({
        assistants: nextList,
        defaultAssistantId: nextList[0]?.id,
      });
      setAssistants(saved.assistants);
      if (editing?.id === id) setEditing(null);
      onAssistantsChanged?.();
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  };

  const toggleSkill = (skillName: string) => {
    if (!editing) return;
    const has = editing.skillNames.includes(skillName);
    setEditing({
      ...editing,
      skillNames: has
        ? editing.skillNames.filter((item) => item !== skillName)
        : [...editing.skillNames, skillName],
    });
  };

  const startEdit = (assistant: AssistantConfig) => {
    setEditing({
      id: assistant.id,
      name: assistant.name,
      provider: assistant.provider,
      model: assistant.model ?? "",
      skillNames: assistant.skillNames ?? [],
      persona: assistant.persona ?? "",
    });
    setIsNew(false);
  };

  const startNew = () => {
    setEditing(emptyAssistant());
    setIsNew(true);
    setSkillSearch("");
  };

  const startEditWithReset = (assistant: AssistantConfig) => {
    startEdit(assistant);
    setSkillSearch("");
  };

  const totalPages = Math.ceil(assistants.length / CARDS_PER_PAGE);
  const pagedAssistants = assistants.slice(
    currentPage * CARDS_PER_PAGE,
    (currentPage + 1) * CARDS_PER_PAGE
  );

  return (
    <>
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/20 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-4xl max-h-[88vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/5 bg-surface p-6 shadow-elevated flex flex-col">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-ink-800">
              助理管理
            </Dialog.Title>
            <div className="flex items-center gap-2">
              {!editing && (
                <button
                  onClick={startNew}
                  className="flex items-center gap-1 rounded-lg border border-ink-900/10 bg-surface-secondary px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-surface-tertiary hover:border-ink-900/20 transition-colors"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  新建助理
                </button>
              )}
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
          </div>

          {editing ? (
            <div className="mt-4 flex flex-1 flex-col gap-0 min-h-0">
              {/* 返回标题行 */}
              <div className="flex items-center gap-2 pb-4">
                <button
                  onClick={() => setEditing(null)}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-sm font-medium text-ink-800">
                  {isNew ? "新建助理" : `编辑 · ${editing.name}`}
                </span>
              </div>

              {/* 左右两栏主体 */}
              <div className="flex flex-1 gap-5 min-h-0 overflow-hidden">
                {/* 左栏：基本信息 */}
                <div className="flex flex-1 flex-col gap-3 min-w-0 min-h-0">
                  {/* 名称 */}
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">名称</span>
                    <input
                      className="rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-2 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                      placeholder="例如：市场助理"
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                  </div>

                  {/* Provider + Model */}
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted">Provider</span>
                      <select
                        className="rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-2 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                        value={editing.provider}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            provider: e.target.value as "claude" | "codex",
                          })
                        }
                      >
                        <option value="claude">Claude</option>
                        <option value="codex">Codex</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted">Model（可选）</span>
                      <input
                        className="rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-2 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                        placeholder="默认模型"
                        value={editing.model}
                        onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                      />
                    </div>
                  </div>

                  {/* 人格设定 */}
                  <div className="flex flex-1 flex-col gap-1 min-h-0">
                    <span className="text-xs font-medium text-muted">人格设定</span>
                    <textarea
                      className="flex-1 min-h-[80px] rounded-xl border border-ink-900/10 bg-surface-secondary p-3 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors resize-none"
                      placeholder="例如：你是一位经验丰富的市场营销专家，擅长数据分析和竞品调研，说话简洁有条理。"
                      value={editing.persona}
                      onChange={(e) => setEditing({ ...editing, persona: e.target.value })}
                    />
                    <span className="text-[11px] text-muted-light">
                      定义助理的角色与行为方式，会在每次对话开头注入。
                    </span>
                  </div>
                </div>

                {/* 分隔线 */}
                <div className="w-px bg-ink-900/6 flex-shrink-0" />

                {/* 右栏：技能 */}
                <div className="flex w-64 flex-shrink-0 flex-col gap-1.5 min-h-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">技能配置</span>
                    {editing.skillNames.length > 0 && (
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                        {editing.skillNames.length} 已选
                      </span>
                    )}
                  </div>

                  {availableSkills.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-ink-900/10 p-4 text-center">
                      <svg viewBox="0 0 24 24" className="mb-2 h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                      <p className="text-xs text-muted">暂无可用技能</p>
                      <p className="mt-0.5 text-[10px] text-muted-light">请在 ~/.claude/skills/ 下安装</p>
                    </div>
                  ) : (
                    <>
                      {/* 搜索框 */}
                      <div className="relative">
                        <svg viewBox="0 0 24 24" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="11" cy="11" r="8" />
                          <path d="M21 21l-4.35-4.35" />
                        </svg>
                        <input
                          type="text"
                          placeholder="搜索技能…"
                          value={skillSearch}
                          onChange={(e) => setSkillSearch(e.target.value)}
                          className="w-full rounded-lg border border-ink-900/10 bg-surface-secondary py-1.5 pl-7 pr-3 text-xs text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                        />
                        {skillSearch && (
                          <button
                            onClick={() => setSkillSearch("")}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink-700 transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {/* 技能列表 */}
                      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-ink-900/8 bg-surface-secondary/50">
                        {(() => {
                          const filtered = availableSkills.filter((s) =>
                            s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
                            (s.description ?? "").toLowerCase().includes(skillSearch.toLowerCase())
                          );
                          if (filtered.length === 0) {
                            return (
                              <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted">
                                无匹配技能
                              </div>
                            );
                          }
                          return (
                            <div className="grid gap-0.5 p-1.5">
                              {filtered.map((skill) => {
                                const checked = editing.skillNames.includes(skill.name);
                                return (
                                  <label
                                    key={skill.name}
                                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${
                                      checked
                                        ? "bg-accent/10 hover:bg-accent/15"
                                        : "hover:bg-surface-secondary"
                                    }`}
                                  >
                                    <div className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${
                                      checked
                                        ? "border-accent bg-accent"
                                        : "border-ink-900/20 bg-white"
                                    }`}>
                                      {checked && (
                                        <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="3">
                                          <path d="M20 6L9 17l-5-5" />
                                        </svg>
                                      )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-xs font-medium text-ink-800 leading-tight">
                                        {skill.name}
                                      </div>
                                      {skill.description && (
                                        <div className="mt-0.5 text-[10px] text-muted line-clamp-1 leading-snug">
                                          {skill.description}
                                        </div>
                                      )}
                                    </div>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleSkill(skill.name)}
                                      className="sr-only"
                                    />
                                  </label>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>

                      {/* 已选技能快速清除 */}
                      {editing.skillNames.length > 0 && (
                        <button
                          onClick={() => setEditing({ ...editing, skillNames: [] })}
                          className="text-[10px] text-muted hover:text-ink-700 transition-colors text-right"
                        >
                          清除全部已选
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="flex flex-shrink-0 items-center gap-3 border-t border-ink-900/6 pt-4 mt-4">
                <button
                  onClick={handleSave}
                  disabled={!editing.name.trim()}
                  className="flex-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isNew ? "创建助理" : "保存修改"}
                </button>
                <button
                  onClick={() => setEditing(null)}
                  className="rounded-xl border border-ink-900/10 bg-surface px-4 py-2 text-sm text-ink-700 hover:bg-surface-tertiary transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-1 flex-col min-h-0">
              {assistants.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-900/10 py-14 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-secondary">
                    <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-ink-700">暂无助理</p>
                  <p className="mt-1 text-xs text-muted">点击右上角「新建助理」创建第一个</p>
                </div>
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto min-h-0">
                  <div className="grid grid-cols-3 gap-3">
                    {pagedAssistants.map((assistant) => {
                      const avatarColor = getAvatarColor(assistant.name);
                      const initial = assistant.name.trim().slice(0, 1).toUpperCase();
                      const skillCount = assistant.skillNames?.length ?? 0;
                      return (
                        <div
                          key={assistant.id}
                          className="group relative flex flex-col rounded-2xl border border-ink-900/8 bg-surface p-4 transition-all hover:shadow-soft hover:border-ink-900/12"
                        >
                          <div className="flex items-start justify-between">
                            <div className={`flex h-11 w-11 items-center justify-center rounded-xl text-lg font-bold ${avatarColor}`}>
                              {initial}
                            </div>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => setBotTargetAssistant(assistant)}
                                className="rounded-lg p-1.5 text-muted hover:bg-ink-900/5 hover:text-ink-700 transition-colors"
                                title="机器人对话"
                              >
                                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                                  <rect x="5" y="11" width="14" height="9" rx="2" />
                                  <path d="M12 2a3 3 0 0 1 3 3v6H9V5a3 3 0 0 1 3-3z" />
                                  <circle cx="9.5" cy="15.5" r="1" fill="currentColor" stroke="none" />
                                  <circle cx="14.5" cy="15.5" r="1" fill="currentColor" stroke="none" />
                                </svg>
                              </button>
                              <button
                                onClick={() => startEditWithReset(assistant)}
                                className="rounded-lg p-1.5 text-muted hover:bg-ink-900/5 hover:text-ink-700 transition-colors"
                                title="编辑"
                              >
                                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                                </svg>
                              </button>
                              <button
                                onClick={() => handleDelete(assistant.id)}
                                className="rounded-lg p-1.5 text-muted hover:bg-error/10 hover:text-error transition-colors"
                                title="删除"
                              >
                                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                                  <path d="M4 7h16" />
                                  <path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
                                  <path d="M7 7l1 12a1 1 0 001 .9h6a1 1 0 001-.9l1-12" />
                                </svg>
                              </button>
                            </div>
                          </div>

                          <div className="mt-3">
                            <div className="text-sm font-semibold text-ink-800 leading-tight truncate">
                              {assistant.name}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                              <span className="rounded-md bg-surface-secondary px-1.5 py-0.5 font-medium uppercase tracking-wide">
                                {assistant.provider}
                              </span>
                              {assistant.model && (
                                <span className="truncate">{assistant.model}</span>
                              )}
                            </div>
                          </div>

                          {assistant.persona && (
                            <p className="mt-2 text-[11px] text-muted line-clamp-2 leading-relaxed">
                              {assistant.persona}
                            </p>
                          )}

                          <div className="mt-auto pt-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <svg viewBox="0 0 24 24" className="h-3 w-3 text-muted" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                </svg>
                                <span className="text-[11px] text-muted">
                                  {skillCount > 0 ? `${skillCount} 个技能` : "无技能"}
                                </span>
                              </div>
                              {(() => {
                                const botCount = Object.values(assistant.bots ?? {}).filter((b: any) => b?.connected).length;
                                return botCount > 0 ? (
                                  <div className="flex items-center gap-1">
                                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    <span className="text-[11px] text-emerald-600">{botCount} 机器人</span>
                                  </div>
                                ) : null;
                              })()}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  </div>

                  {totalPages > 1 && (
                    <div className="mt-4 flex flex-shrink-0 items-center justify-center gap-2">
                      <button
                        onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                        disabled={currentPage === 0}
                        className="rounded-lg border border-ink-900/10 p-1.5 text-muted hover:bg-surface-secondary hover:text-ink-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M15 18l-6-6 6-6" />
                        </svg>
                      </button>
                      <div className="flex items-center gap-1.5">
                        {Array.from({ length: totalPages }, (_, i) => (
                          <button
                            key={i}
                            onClick={() => setCurrentPage(i)}
                            className={`h-6 min-w-[24px] rounded-md px-1.5 text-xs transition-colors ${
                              i === currentPage
                                ? "bg-accent text-white font-medium"
                                : "text-muted hover:bg-surface-secondary hover:text-ink-700"
                            }`}
                          >
                            {i + 1}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
                        disabled={currentPage === totalPages - 1}
                        className="rounded-lg border border-ink-900/10 p-1.5 text-muted hover:bg-surface-secondary hover:text-ink-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {botTargetAssistant && (
      <BotConfigModal
        open={!!botTargetAssistant}
        onOpenChange={(v) => { if (!v) setBotTargetAssistant(null); }}
        assistantId={botTargetAssistant.id}
        assistantName={botTargetAssistant.name}
        provider={botTargetAssistant.provider}
        model={botTargetAssistant.model}
        defaultCwd={botTargetAssistant.defaultCwd}
        initialBots={(botTargetAssistant.bots ?? {}) as Partial<Record<BotPlatformType, BotPlatformConfig>>}
        onSave={async (bots) => {
          const updated: AssistantConfig = { ...botTargetAssistant, bots: bots as any };
          const nextList = assistants.map((a) => a.id === updated.id ? updated : a);
          try {
            const saved = await window.electron.saveAssistantsConfig({
              assistants: nextList,
              defaultAssistantId: nextList[0]?.id,
            });
            setAssistants(saved.assistants);
            setBotTargetAssistant(updated);
            onAssistantsChanged?.();
          } catch (err) {
            console.error("Failed to save bot config:", err);
          }
        }}
      />
    )}
    </>
  );
}
