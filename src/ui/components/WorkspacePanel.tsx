import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, type SessionView } from "../store/useAppStore";

interface WorkspacePanelProps {
  onClose: () => void;
}

type Tab = "output" | "all";

// ─── localStorage helper ──────────────────────────────────────────────────────
const ASSISTANT_CWDS_KEY = "vk-cowork-assistant-cwds";
function getAssistantCwds(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(ASSISTANT_CWDS_KEY) || "{}"); }
  catch { return {}; }
}

// ─── File helpers ─────────────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm", "flv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "aac", "flac", "ogg", "m4a"]);
const DOC_EXTS   = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key"]);
const CODE_EXTS  = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cpp", "c", "h", "css", "scss", "html", "vue", "svelte", "sh", "bash", "zsh"]);
const DATA_EXTS  = new Set(["json", "yaml", "yml", "toml", "csv", "xml", "sql"]);
const TEXT_EXTS  = new Set(["md", "mdx", "txt", "log", "env"]);

function getExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

interface FileStyle { color: string; bg: string; label: string }
function getFileStyle(name: string, isDir: boolean): FileStyle {
  if (isDir) return { color: "text-amber-500", bg: "bg-amber-50", label: "DIR" };
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return { color: "text-purple-500", bg: "bg-purple-50", label: ext.toUpperCase() };
  if (VIDEO_EXTS.has(ext)) return { color: "text-red-500",    bg: "bg-red-50",    label: ext.toUpperCase() };
  if (AUDIO_EXTS.has(ext)) return { color: "text-pink-500",   bg: "bg-pink-50",   label: ext.toUpperCase() };
  if (DOC_EXTS.has(ext))   return { color: "text-orange-500", bg: "bg-orange-50", label: ext.toUpperCase() };
  if (CODE_EXTS.has(ext))  return { color: "text-blue-500",   bg: "bg-blue-50",   label: ext.toUpperCase() };
  if (DATA_EXTS.has(ext))  return { color: "text-teal-500",   bg: "bg-teal-50",   label: ext.toUpperCase() };
  if (TEXT_EXTS.has(ext))  return { color: "text-violet-500", bg: "bg-violet-50", label: ext.toUpperCase() };
  return { color: "text-ink-400", bg: "bg-surface-tertiary", label: ext ? ext.toUpperCase() : "FILE" };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

// ─── Extract produced files from session tool_use messages ────────────────────
interface ProducedFile { path: string; resolvedPath: string; sessionTitle: string; sessionId: string }

const FILE_PATH_FIELDS = ["path", "file_path", "filepath", "filename", "target_path", "output_path", "dest", "new_path"];

// Tools that are purely read-only — skip these
const READ_ONLY_TOOLS = new Set(["read_file", "view_file", "cat", "ls", "find", "grep"]);

function isReadOnlyOp(toolName: string, input: Record<string, any>): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  // str_replace_based_edit_tool with command="view" is read-only
  if (input.command === "view" || input.command === "read") return true;
  return false;
}

function resolvePath(filePath: string, cwd?: string): string {
  // Already absolute
  if (filePath.startsWith("/") || /^[A-Za-z]:[/\\]/.test(filePath)) return filePath;
  // Relative — join with cwd
  if (cwd) {
    const base = cwd.replace(/\/$/, "");
    const rel = filePath.replace(/^\.\//, "");
    return `${base}/${rel}`;
  }
  return filePath;
}

function addFile(seen: Set<string>, result: ProducedFile[], path: string, session: SessionView) {
  if (seen.has(path)) return;
  const name = basename(path);
  // Must have an extension and not be a hidden file
  if (!name.includes(".") || name.startsWith(".")) return;
  seen.add(path);
  const resolvedPath = resolvePath(path, session.cwd);
  result.push({ path, resolvedPath, sessionTitle: session.title || "未命名任务", sessionId: session.id });
}

function extractProducedFiles(sessions: SessionView[]): ProducedFile[] {
  const seen = new Set<string>();
  const result: ProducedFile[] = [];

  for (const session of sessions) {
    // Use messages regardless of hydrated — streaming sessions have messages but hydrated=false
    if (session.messages.length === 0) continue;

    for (const msg of session.messages) {
      const m = msg as any;
      if (m.type !== "assistant") continue;
      const content: any[] = m.message?.content ?? [];

      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const toolName: string = (block.name ?? "").toLowerCase();
        const input = (block.input ?? {}) as Record<string, any>;

        if (isReadOnlyOp(toolName, input)) continue;

        // bash / shell: parse file redirections (>, >>, tee)
        if (toolName === "bash" || toolName === "shell" || toolName === "run_command") {
          const cmd: string = input.command ?? input.cmd ?? input.script ?? "";
          if (typeof cmd === "string") {
            // Match: > file, >> file, tee file, tee -a file
            const matches = cmd.matchAll(/(?:>>?|tee\s+(?:-a\s+)?)\s*["']?([^\s"'|&;<>]+\.[a-zA-Z0-9]+)/g);
            for (const match of matches) {
              addFile(seen, result, match[1], session);
            }
          }
          continue;
        }

        // All other tools: look for path-like fields in input
        for (const field of FILE_PATH_FIELDS) {
          const val = input[field];
          if (val && typeof val === "string") {
            addFile(seen, result, val, session);
          }
        }
      }
    }
  }
  return result;
}

// ─── File row ─────────────────────────────────────────────────────────────────
function FileRow({ name, fullPath, isDir, size, depth = 0 }: {
  name: string; fullPath: string; isDir: boolean; size?: number; depth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const style = getFileStyle(name, isDir);

  const handleClick = useCallback(async () => {
    if (!isDir) { window.electron.openPath(fullPath); return; }
    if (!open && children === null) {
      setLoading(true);
      const items = await window.electron.readDir(fullPath).catch(() => []);
      setChildren(items);
      setLoading(false);
    }
    setOpen((v) => !v);
  }, [isDir, fullPath, open, children]);

  return (
    <>
      <div
        className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-secondary transition-colors"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleClick}
        title={fullPath}
      >
        {/* chevron */}
        {isDir ? (
          <svg
            viewBox="0 0 24 24"
            className={`h-2.5 w-2.5 shrink-0 text-muted-light transition-transform ${open ? "rotate-90" : ""}`}
            fill="none" stroke="currentColor" strokeWidth="2.5"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        ) : <span className="h-2.5 w-2.5 shrink-0" />}

        {/* type badge */}
        <span className={`shrink-0 rounded px-1 py-px text-[9px] font-bold leading-none ${style.color} ${style.bg}`}>
          {isDir ? (
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" stroke="none">
              <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
            </svg>
          ) : style.label}
        </span>

        {/* name */}
        <span className={`flex-1 truncate text-[12px] ${isDir ? "font-medium text-ink-700" : "text-ink-600"}`}>
          {name}
        </span>

        {/* size */}
        {!isDir && size !== undefined && (
          <span className="shrink-0 text-[10px] text-muted-light opacity-0 group-hover:opacity-100">
            {formatSize(size)}
          </span>
        )}

        {loading && (
          <svg className="h-3 w-3 shrink-0 animate-spin text-muted-light" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        )}
      </div>

      {isDir && open && children !== null && (
        <div>
          {children.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-muted-light" style={{ paddingLeft: `${8 + (depth + 1) * 16 + 20}px` }}>
              空文件夹
            </div>
          ) : (
            children.map((c) => (
              <FileRow key={c.path} name={c.name} fullPath={c.path} isDir={c.isDir} size={c.size} depth={depth + 1} />
            ))
          )}
        </div>
      )}
    </>
  );
}

// ─── Produced files tab ───────────────────────────────────────────────────────
function ProducedFilesTab({ sessions }: { sessions: SessionView[] }) {
  const requestedRef = useRef<Set<string>>(new Set());

  // Request history for sessions that have no messages yet (not streamed, not hydrated)
  useEffect(() => {
    for (const s of sessions) {
      if (!s.hydrated && s.messages.length === 0 && !requestedRef.current.has(s.id)) {
        requestedRef.current.add(s.id);
        window.electron.sendClientEvent({ type: "session.history", payload: { sessionId: s.id } });
      }
    }
  }, [sessions]);

  // Only show loading if there are sessions with no messages at all (history pending)
  const hasPending = sessions.some((s) => !s.hydrated && s.messages.length === 0);
  const producedFiles = useMemo(() => extractProducedFiles(sessions), [sessions]);

  if (hasPending && producedFiles.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 px-3 py-4">
        {[0.7, 0.55, 0.8, 0.5, 0.65, 0.75].map((w, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <div className="h-5 w-8 rounded bg-ink-900/8 animate-pulse" />
            <div className="h-2.5 rounded-full bg-ink-900/8 animate-pulse" style={{ width: `${w * 100}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (producedFiles.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-secondary">
          <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" /><polyline points="13 2 13 9 20 9" />
          </svg>
        </div>
        <p className="text-xs text-muted">暂未发现产出文件</p>
      </div>
    );
  }

  // Group by sessionId
  const bySession: Record<string, ProducedFile[]> = {};
  for (const f of producedFiles) {
    if (!bySession[f.sessionId]) bySession[f.sessionId] = [];
    bySession[f.sessionId].push(f);
  }

  return (
    <div className="py-2">
      {Object.entries(bySession).map(([sid, files]) => (
        <div key={sid} className="mb-3">
          <div className="px-3 py-1.5">
            <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-light">
              {files[0]?.sessionTitle}
            </p>
          </div>
          <div className="px-1">
            {files.map((f) => {
              const name = basename(f.resolvedPath);
              const style = getFileStyle(name, false);
              const parentDir = f.resolvedPath.split(/[\\/]/).slice(-2, -1)[0] ?? "";
              return (
                <div
                  key={f.path}
                  className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-secondary transition-colors"
                  onClick={() => {
                    const parts = f.resolvedPath.split(/[\\/]/);
                    parts.pop();
                    const dir = parts.join("/") || "/";
                    window.electron.openPath(dir);
                  }}
                  title={f.resolvedPath}
                >
                  <span className={`shrink-0 rounded px-1 py-px text-[9px] font-bold leading-none ${style.color} ${style.bg}`}>
                    {style.label}
                  </span>
                  <span className="flex-1 truncate text-[12px] text-ink-600">{name}</span>
                  <span className="shrink-0 truncate text-[10px] text-muted-light opacity-0 group-hover:opacity-100 max-w-[80px]">
                    {parentDir}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── All files tab ────────────────────────────────────────────────────────────
function AllFilesTab({ cwd, onRefreshRef }: { cwd: string; onRefreshRef?: React.MutableRefObject<(() => void) | null> }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await window.electron.readDir(cwd);
      setEntries(items);
    } catch (e) {
      console.error("[AllFilesTab] readDir failed:", e);
      setError("无法读取目录，请重试");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  // Expose refresh to parent via ref
  useEffect(() => {
    if (onRefreshRef) onRefreshRef.current = load;
  }, [load, onRefreshRef]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col gap-1.5 px-3 py-4">
        {[0.85, 0.6, 0.75, 0.5, 0.9, 0.65, 0.7, 0.55].map((w, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <div className="h-5 w-8 rounded bg-ink-900/8 animate-pulse" />
            <div className="h-2.5 rounded-full bg-ink-900/8 animate-pulse" style={{ width: `${w * 100}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <svg viewBox="0 0 24 24" className="h-8 w-8 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <p className="text-xs text-muted">{error}</p>
        <button onClick={load} className="mt-1 rounded-lg bg-surface-secondary px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-surface-tertiary transition-colors">
          重试
        </button>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <svg viewBox="0 0 24 24" className="h-8 w-8 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
        </svg>
        <p className="text-xs text-muted">目录为空</p>
      </div>
    );
  }

  return (
    <div className="py-1 px-1">
      {entries.map((e) => (
        <FileRow key={e.path} name={e.name} fullPath={e.path} isDir={e.isDir} size={e.size} depth={0} />
      ))}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export function WorkspacePanel({ onClose }: WorkspacePanelProps) {
  const [tab, setTab] = useState<Tab>("output");
  const sessions  = useAppStore((s) => s.sessions);
  const cwd       = useAppStore((s) => s.cwd);
  const selectedAssistantId = useAppStore((s) => s.selectedAssistantId);
  const refreshAllFilesRef = useRef<(() => void) | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (refreshAllFilesRef.current) {
      setRefreshing(true);
      await Promise.resolve(refreshAllFilesRef.current());
      setTimeout(() => setRefreshing(false), 400);
    }
  }, []);

  const [assistantName, setAssistantName] = useState("");

  useEffect(() => {
    if (!selectedAssistantId) { setAssistantName(""); return; }
    window.electron.getAssistantsConfig()
      .then((c) => setAssistantName(c.assistants.find((a) => a.id === selectedAssistantId)?.name ?? ""))
      .catch(console.error);
  }, [selectedAssistantId]);

  // Resolve cwd
  const resolvedCwd = useMemo(() => {
    if (cwd) return cwd;
    if (selectedAssistantId) {
      const saved = getAssistantCwds()[selectedAssistantId];
      if (saved) return saved;
    }
    const list = Object.values(sessions)
      .filter((s) => !selectedAssistantId || s.assistantId === selectedAssistantId)
      .filter((s) => !!s.cwd)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return list[0]?.cwd ?? null;
  }, [cwd, selectedAssistantId, sessions]);

  const assistantSessions = useMemo(() =>
    Object.values(sessions)
      .filter((s) => !selectedAssistantId || s.assistantId === selectedAssistantId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [sessions, selectedAssistantId]
  );

  const cwdName   = resolvedCwd ? resolvedCwd.split(/[\\/]+/).filter(Boolean).pop() : null;
  const cwdParent = useMemo(() => {
    if (!resolvedCwd) return null;
    const parts = resolvedCwd.split(/[\\/]+/).filter(Boolean);
    return parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : null;
  }, [resolvedCwd]);

  return (
    <div className="flex h-full flex-col bg-surface-cream">
      {/* Header */}
      <div
        className="shrink-0 border-b border-ink-900/10 bg-surface-cream px-4 pt-3 pb-0"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {/* Title row */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink-800 leading-tight">工作区文件</h2>
            {(cwdName || assistantName) && (
              <p className="mt-0.5 truncate text-[11px] text-muted-light">
                {cwdName ?? assistantName}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex shrink-0 items-center gap-0.5">
            {resolvedCwd && tab === "all" && (
              <button
                onClick={handleRefresh}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-secondary hover:text-ink-700 transition-colors"
                title="刷新"
              >
                <svg
                  viewBox="0 0 24 24"
                  className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                  fill="none" stroke="currentColor" strokeWidth="2"
                >
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                </svg>
              </button>
            )}
            {resolvedCwd && (
              <button
                onClick={() => window.electron.openPath(resolvedCwd)}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-secondary hover:text-ink-700 transition-colors"
                title="在 Finder 中打开"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted hover:bg-surface-secondary hover:text-ink-700 transition-colors"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0">
          {(["output", "all"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative pb-2 px-1 mr-4 text-[12.5px] font-medium transition-colors ${
                tab === t ? "text-ink-800" : "text-muted hover:text-ink-600"
              }`}
            >
              {t === "output" ? "产出文件" : "所有文件"}
              {tab === t && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-accent" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!resolvedCwd ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-secondary">
              <svg viewBox="0 0 24 24" className="h-7 w-7 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-ink-700">未设置工作区</p>
              <p className="mt-1 text-xs text-muted">选择一个工作目录后即可浏览文件</p>
            </div>
          </div>
        ) : tab === "output" ? (
          <ProducedFilesTab sessions={assistantSessions} />
        ) : (
          <AllFilesTab cwd={resolvedCwd} onRefreshRef={refreshAllFilesRef} />
        )}
      </div>

      {/* Footer */}
      {resolvedCwd && (
        <div className="shrink-0 border-t border-ink-900/8 px-4 py-2">
          <p className="truncate text-[10px] text-muted-light" title={resolvedCwd}>
            {cwdParent ? `${cwdParent}/` : ""}<span className="font-medium text-ink-500">{cwdName}</span>
          </p>
        </div>
      )}
    </div>
  );
}
