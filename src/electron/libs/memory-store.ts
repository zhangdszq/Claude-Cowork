/**
 * Memory Store — OpenClaw Memory 2.0
 *
 * L0/L1/L2 retrieval layers + P0/P1/P2 lifecycle + .abstract index
 *
 * ~/.vk-cowork/memory/
 * ├── .abstract              L0 root index (auto-generated manifest)
 * ├── MEMORY.md              long-term memory (P0/P1/P2 lifecycle tags)
 * ├── SESSION-STATE.md       working buffer (cross-session context handoff)
 * ├── daily/                 L2 raw logs (append-only, one file per day)
 * ├── insights/              L1 monthly distillation
 * ├── lessons/               L1 structured lessons
 * └── archive/               expired P1/P2 items
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, renameSync, unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Paths ──────────────────────────────────────────────────

const MEMORY_ROOT        = join(homedir(), ".vk-cowork", "memory");
const LONG_TERM_FILE     = join(MEMORY_ROOT, "MEMORY.md");
const SESSION_STATE_FILE = join(MEMORY_ROOT, "SESSION-STATE.md");
const ROOT_ABSTRACT      = join(MEMORY_ROOT, ".abstract");
const DAILY_DIR          = join(MEMORY_ROOT, "daily");
const INSIGHTS_DIR       = join(MEMORY_ROOT, "insights");
const LESSONS_DIR        = join(MEMORY_ROOT, "lessons");
const ARCHIVE_DIR        = join(MEMORY_ROOT, "archive");

const ALL_DIRS = [MEMORY_ROOT, DAILY_DIR, INSIGHTS_DIR, LESSONS_DIR, ARCHIVE_DIR];

function ensureDirs(): void {
  for (const dir of ALL_DIRS) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // Seed empty .abstract files for sub-directories on first run
  for (const dir of [INSIGHTS_DIR, LESSONS_DIR]) {
    const abs = join(dir, ".abstract");
    if (!existsSync(abs)) {
      writeFileSync(abs, `# ${dir.split("/").pop()} index\n## recency\n- initialized: ${localDateStr()}\n`, "utf8");
    }
  }
}

export function getMemoryDir(): string {
  ensureDirs();
  return MEMORY_ROOT;
}

// ─── Date helpers (local time — fixes UTC off-by-one) ────────

export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

function localMonthStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dailyPath(date: string): string {
  return join(DAILY_DIR, `${date}.md`);
}

// ─── Atomic write ─────────────────────────────────────────────

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

// ─── Long-term memory (MEMORY.md) ────────────────────────────

export function readLongTermMemory(): string {
  ensureDirs();
  if (!existsSync(LONG_TERM_FILE)) return "";
  return readFileSync(LONG_TERM_FILE, "utf8");
}

export function writeLongTermMemory(content: string): void {
  ensureDirs();
  atomicWrite(LONG_TERM_FILE, content);
}

// ─── Session state buffer (SESSION-STATE.md) ─────────────────

export function readSessionState(): string {
  ensureDirs();
  if (!existsSync(SESSION_STATE_FILE)) return "";
  return readFileSync(SESSION_STATE_FILE, "utf8");
}

export function writeSessionState(content: string): void {
  ensureDirs();
  atomicWrite(SESSION_STATE_FILE, content);
}

export function clearSessionState(): void {
  if (existsSync(SESSION_STATE_FILE)) atomicWrite(SESSION_STATE_FILE, "");
}

// ─── Daily (L2) ───────────────────────────────────────────────

export function readDailyMemory(date: string): string {
  ensureDirs();
  const p = dailyPath(date);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

export function appendDailyMemory(content: string, date?: string): void {
  ensureDirs();
  const p = dailyPath(date ?? localDateStr());
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  atomicWrite(p, existing ? existing + "\n" + content : content);
  // Refresh root abstract after each write (non-blocking)
  try { refreshRootAbstract(); } catch { /* ignore */ }
}

export function writeDailyMemory(content: string, date: string): void {
  ensureDirs();
  atomicWrite(dailyPath(date), content);
}

export function readRecentDailyMemories(): {
  today: string; yesterday: string; todayDate: string; yesterdayDate: string;
} {
  const td = localDateStr();
  const yd = localYesterday();
  return {
    today: readDailyMemory(td),
    yesterday: readDailyMemory(yd),
    todayDate: td,
    yesterdayDate: yd,
  };
}

// ─── .abstract (L0 index) ─────────────────────────────────────

export function readAbstract(dir: string = MEMORY_ROOT): string {
  const p = join(dir, ".abstract");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

export function writeAbstract(dir: string, content: string): void {
  atomicWrite(join(dir, ".abstract"), content);
}

/**
 * Auto-generate root .abstract from file manifest.
 * No API call — pure structural index for L0 navigation.
 */
export function refreshRootAbstract(): void {
  ensureDirs();

  const dailies = listDailyMemories();
  const recentDailies = dailies.slice(0, 7);

  // Extract headings from MEMORY.md as topic hints
  const lt = readLongTermMemory();
  const headings = (lt.match(/^#+\s+.+/gm) ?? []).slice(0, 8);
  const taggedItems = (lt.match(/^[-*]\s+\[P[012][^\]]*\].{0,60}/gm) ?? []).slice(0, 8);
  const topicLines = headings.length ? headings : taggedItems;

  // Insight files
  const insightFiles = existsSync(INSIGHTS_DIR)
    ? readdirSync(INSIGHTS_DIR).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 3)
    : [];

  const lines: string[] = [
    "# memory index",
    "",
    "## recent daily logs (L2)",
    ...(recentDailies.length
      ? recentDailies.map(d => `- ${d.date}.md  (${(d.size / 1024).toFixed(1)}KB)`)
      : ["- (empty)"]),
    "",
    "## long-term topics",
    ...(topicLines.length ? topicLines : ["- (empty)"]),
    "",
  ];

  if (insightFiles.length) {
    lines.push("## insights (L1)");
    insightFiles.forEach(f => lines.push(`- insights/${f}`));
    lines.push("");
  }

  lines.push(
    "## recency",
    `- last updated: ${localDateStr()} ${new Date().toTimeString().slice(0, 5)}`,
  );

  writeAbstract(MEMORY_ROOT, lines.join("\n"));
}

// ─── List ─────────────────────────────────────────────────────

export type MemoryFileInfo = {
  date: string;
  path: string;
  size: number;
};

export function listDailyMemories(): MemoryFileInfo[] {
  ensureDirs();
  if (!existsSync(DAILY_DIR)) return [];
  return readdirSync(DAILY_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const p = join(DAILY_DIR, f);
      const content = existsSync(p) ? readFileSync(p, "utf8") : "";
      return { date: f.replace(".md", ""), path: p, size: Buffer.byteLength(content, "utf8") };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getMemorySummary(): { longTermSize: number; dailyCount: number; totalSize: number } {
  const lt = readLongTermMemory();
  const dailies = listDailyMemories();
  const dailyTotalSize = dailies.reduce((sum, d) => sum + d.size, 0);
  const ltSize = Buffer.byteLength(lt, "utf8");
  return { longTermSize: ltSize, dailyCount: dailies.length, totalSize: ltSize + dailyTotalSize };
}

// ─── P0/P1/P2 Lifecycle Janitor ───────────────────────────────

const LIFECYCLE_RE = /\[P[12]\|expire:(\d{4}-\d{2}-\d{2})\]/;

/**
 * Scan MEMORY.md for expired P1/P2 items, move them to archive/.
 * Called on app startup and once per day.
 */
export function runMemoryJanitor(): { archived: number; cleaned: string[] } {
  ensureDirs();
  const lt = readLongTermMemory();
  if (!lt) return { archived: 0, cleaned: [] };

  const today = localDateStr();
  const lines = lt.split("\n");
  const kept: string[] = [];
  const expired: string[] = [];

  for (const line of lines) {
    const m = line.match(LIFECYCLE_RE);
    if (m && m[1] < today) {
      expired.push(line);
    } else {
      kept.push(line);
    }
  }

  if (expired.length === 0) return { archived: 0, cleaned: [] };

  // Append expired items to archive/YYYY-MM.md
  const archiveFile = join(ARCHIVE_DIR, `${localMonthStr()}.md`);
  const existing = existsSync(archiveFile) ? readFileSync(archiveFile, "utf8") : "";
  atomicWrite(
    archiveFile,
    existing + `\n## Archived ${today}\n` + expired.join("\n") + "\n",
  );

  writeLongTermMemory(kept.join("\n"));
  try { refreshRootAbstract(); } catch { /* non-blocking */ }

  console.log(`[MemoryJanitor] Archived ${expired.length} expired item(s).`);
  return { archived: expired.length, cleaned: expired };
}

// ─── Keyword scoring ──────────────────────────────────────────

const STOPWORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "和", "有",
  "就", "不", "也", "都", "为", "以", "这", "那", "到", "从", "上", "把",
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "have",
  "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "can", "to", "of", "in", "for", "on", "with", "at",
  "by", "from", "as", "into", "about", "up", "out", "not", "and", "or",
]);

function tokenize(text: string): Set<string> {
  // Match individual CJK chars and English words of ≥2 chars
  const words = text.toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9]{2,}/g) ?? [];
  return new Set(words.filter(w => !STOPWORDS.has(w)));
}

function scoreContent(content: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const ct = tokenize(content);
  let hits = 0;
  for (const t of queryTokens) { if (ct.has(t)) hits++; }
  return hits / queryTokens.size;
}

// ─── Context assembly ─────────────────────────────────────────

const MEMORY_PROTOCOL = `
[记忆系统规则]
你拥有跨会话的持久记忆能力。上面 <memory> 标签内是你的历史记忆。

━━ 记忆层级 ━━
- L0: ~/.vk-cowork/memory/.abstract              目录索引，先读这里锁定查找范围
- L1: ~/.vk-cowork/memory/insights/YYYY-MM.md    月度提炼要点（每周压缩一次）
- L2: ~/.vk-cowork/memory/daily/YYYY-MM-DD.md    原始日志，append-only

━━ 写入规则 ━━
写入 ~/.vk-cowork/memory/MEMORY.md（用文件编辑工具）：
  [P0]                    用户偏好、核心原则（永久）
  [P1|expire:YYYY-MM-DD]  活跃项目决策和技术方案（90 天后过期）
  [P2|expire:YYYY-MM-DD]  临时信息如测试地址、配置（30 天后过期）

追加到 ~/.vk-cowork/memory/daily/今日日期.md：
  当日事件、完成的任务、新发现的问题

写入 ~/.vk-cowork/memory/SESSION-STATE.md：
  跨会话的工作状态快照（下次会话可直接继续）

━━ 会话结束前的责任（重要）━━
每次完成用户最后一个任务后，如果本次会话产生了值得记住的信息，
你必须主动完成以下操作，不要等用户提醒：
1. 把新的用户偏好/决策写入 MEMORY.md，按 [P0]/[P1]/[P2] 标注
2. 把本次会话摘要（做了什么、决定了什么）追加写入 daily/今日.md
3. 如有未完成任务或下次需继续的上下文，更新 SESSION-STATE.md

过期的 P1/P2 条目会被后台 janitor 自动归档到 archive/，无需手动处理。
`.trim();

const TOKEN_BUDGET = 6000;

/**
 * Build a smart memory context for the given prompt.
 * Strategy: .abstract (L0) → scored historical dailies → budget cap.
 */
export function buildSmartMemoryContext(prompt: string): string {
  ensureDirs();

  const queryTokens = tokenize(prompt);
  const todayDate = localDateStr();
  const yesterdayDate = localYesterday();

  const abstract = readAbstract(MEMORY_ROOT).trim();
  const longTerm = readLongTermMemory().trim();
  const sessionState = readSessionState().trim();
  const todayContent = readDailyMemory(todayDate).trim();
  const yesterdayContent = readDailyMemory(yesterdayDate).trim();

  // Score historical daily files (skip today and yesterday)
  const allDailies = listDailyMemories();
  const historicalScored = allDailies
    .filter(d => d.date !== todayDate && d.date !== yesterdayDate)
    .map(d => {
      const content = readDailyMemory(d.date);
      return { date: d.date, content, score: scoreContent(content, queryTokens) };
    })
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const parts: string[] = ["<memory>"];
  let used = 0;

  const push = (s: string) => { parts.push(s); used += s.length; };

  if (abstract) {
    push("## 目录索引 (.abstract)");
    push(abstract);
    push("");
  }
  if (longTerm) {
    push("## 长期记忆");
    push(longTerm);
    push("");
  }
  if (sessionState) {
    push("## 会话缓冲 (SESSION-STATE.md)");
    push(sessionState);
    push("");
  }
  if (todayContent) {
    push(`## 今日笔记 (${todayDate})`);
    push(todayContent);
    push("");
  }
  if (yesterdayContent) {
    push(`## 昨日笔记 (${yesterdayDate})`);
    push(yesterdayContent);
    push("");
  }

  // Relevant historical entries within budget
  for (const d of historicalScored) {
    const remaining = TOKEN_BUDGET - used;
    if (remaining < 200) break;

    push(`## 历史相关 (${d.date})`);
    if (d.content.length > remaining - 100) {
      push(d.content.slice(0, remaining - 100) + "\n…[截断]");
    } else {
      push(d.content);
    }
    push("");
    used += d.content.length;
  }

  if (parts.length === 1) push("（暂无历史记忆）");

  parts.push("</memory>");
  parts.push("");
  parts.push(MEMORY_PROTOCOL);

  return parts.join("\n");
}

/** Legacy alias — kept for backward compat */
export function buildMemoryContext(): string {
  return buildSmartMemoryContext("");
}
