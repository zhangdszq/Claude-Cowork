/**
 * Memory Store
 *
 * Dual-layer Markdown memory system inspired by OpenClaw:
 *   - MEMORY.md         — long-term curated memory (preferences, decisions, facts)
 *   - daily/YYYY-MM-DD.md — daily append-only logs
 *
 * On new session start the store assembles a context string that is injected
 * into the agent prompt so it "remembers" across conversations.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Paths ───────────────────────────────────────────────────

const MEMORY_ROOT = join(homedir(), ".vk-cowork", "memory");
const LONG_TERM_FILE = join(MEMORY_ROOT, "MEMORY.md");
const DAILY_DIR = join(MEMORY_ROOT, "daily");

function ensureDirs(): void {
  if (!existsSync(MEMORY_ROOT)) {
    mkdirSync(MEMORY_ROOT, { recursive: true });
  }
  if (!existsSync(DAILY_DIR)) {
    mkdirSync(DAILY_DIR, { recursive: true });
  }
}

/** Return the root memory directory path */
export function getMemoryDir(): string {
  ensureDirs();
  return MEMORY_ROOT;
}

// ─── Date helpers ────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dailyPath(date: string): string {
  return join(DAILY_DIR, `${date}.md`);
}

// ─── Read ────────────────────────────────────────────────────

/** Read the long-term MEMORY.md (returns empty string if not exists) */
export function readLongTermMemory(): string {
  ensureDirs();
  if (!existsSync(LONG_TERM_FILE)) return "";
  return readFileSync(LONG_TERM_FILE, "utf8");
}

/** Read a specific daily memory file */
export function readDailyMemory(date: string): string {
  ensureDirs();
  const p = dailyPath(date);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

/** Read today + yesterday daily memories */
export function readRecentDailyMemories(): { today: string; yesterday: string; todayDate: string; yesterdayDate: string } {
  const td = todayStr();
  const yd = yesterdayStr();
  return {
    today: readDailyMemory(td),
    yesterday: readDailyMemory(yd),
    todayDate: td,
    yesterdayDate: yd,
  };
}

// ─── Write ───────────────────────────────────────────────────

/**
 * Atomic write: write to a .tmp file then rename into place.
 * On POSIX systems rename() is atomic; on Windows it falls back to a
 * direct overwrite (rename throws if dest exists, so we remove first).
 */
function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    // Windows: destination may already exist
    try { unlinkSync(filePath); } catch { /* ignore */ }
    renameSync(tmp, filePath);
  }
}

/** Overwrite the long-term MEMORY.md */
export function writeLongTermMemory(content: string): void {
  ensureDirs();
  atomicWrite(LONG_TERM_FILE, content);
}

/** Append content to today's daily memory (or a specific date) */
export function appendDailyMemory(content: string, date?: string): void {
  ensureDirs();
  const p = dailyPath(date ?? todayStr());
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const next = existing ? existing + "\n" + content : content;
  atomicWrite(p, next);
}

/** Overwrite a daily memory file */
export function writeDailyMemory(content: string, date: string): void {
  ensureDirs();
  atomicWrite(dailyPath(date), content);
}

// ─── List ────────────────────────────────────────────────────

export type MemoryFileInfo = {
  date: string;
  path: string;
  size: number;
};

/** List all daily memory files sorted by date descending */
export function listDailyMemories(): MemoryFileInfo[] {
  ensureDirs();
  if (!existsSync(DAILY_DIR)) return [];
  const files = readdirSync(DAILY_DIR).filter((f) => f.endsWith(".md"));
  return files
    .map((f) => {
      const p = join(DAILY_DIR, f);
      const content = existsSync(p) ? readFileSync(p, "utf8") : "";
      return { date: f.replace(".md", ""), path: p, size: Buffer.byteLength(content, "utf8") };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Get a summary of all memories (for UI display) */
export function getMemorySummary(): { longTermSize: number; dailyCount: number; totalSize: number } {
  const lt = readLongTermMemory();
  const dailies = listDailyMemories();
  const dailyTotalSize = dailies.reduce((sum, d) => sum + d.size, 0);
  const ltSize = Buffer.byteLength(lt, "utf8");
  return {
    longTermSize: ltSize,
    dailyCount: dailies.length,
    totalSize: ltSize + dailyTotalSize,
  };
}

// ─── Context assembly ────────────────────────────────────────

const MEMORY_INSTRUCTIONS = `
[记忆系统说明]
你拥有跨会话的持久记忆能力。上面 <memory> 标签内是你的历史记忆。

记忆写入规则：
- 重要的长期信息（用户偏好、项目决策、关键事实）→ 写入 MEMORY.md（路径: ~/.vk-cowork/memory/MEMORY.md）
- 日常临时笔记（今天做了什么、临时上下文）→ 追加写入 daily/今天日期.md（路径: ~/.vk-cowork/memory/daily/YYYY-MM-DD.md）
- 使用文件编辑工具写入记忆文件
- 当用户告诉你重要偏好或需要记住的内容时，主动写入记忆
- MEMORY.md 应保持精简，定期整理去除过时信息
`.trim();

/**
 * Assemble the full memory context to inject into the agent prompt.
 * Returns empty string if there is nothing to inject.
 */
export function buildMemoryContext(): string {
  const longTerm = readLongTermMemory().trim();
  const { today, yesterday, todayDate, yesterdayDate } = readRecentDailyMemories();
  const todayTrimmed = today.trim();
  const yesterdayTrimmed = yesterday.trim();

  // Nothing to inject
  if (!longTerm && !todayTrimmed && !yesterdayTrimmed) {
    // Still include instructions so the agent knows it CAN write memories
    return `<memory>\n（暂无历史记忆）\n</memory>\n\n${MEMORY_INSTRUCTIONS}`;
  }

  const parts: string[] = ["<memory>"];

  if (longTerm) {
    parts.push("## 长期记忆");
    parts.push(longTerm);
    parts.push("");
  }

  if (todayTrimmed) {
    parts.push(`## 今日笔记 (${todayDate})`);
    parts.push(todayTrimmed);
    parts.push("");
  }

  if (yesterdayTrimmed) {
    parts.push(`## 昨日笔记 (${yesterdayDate})`);
    parts.push(yesterdayTrimmed);
    parts.push("");
  }

  parts.push("</memory>");
  parts.push("");
  parts.push(MEMORY_INSTRUCTIONS);

  return parts.join("\n");
}
