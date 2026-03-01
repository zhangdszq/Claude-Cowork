/**
 * Memory Store — OpenClaw Memory 2.0 + SOP Self-Evolution
 *
 * L0/L1/L2 retrieval layers + P0/P1/P2 lifecycle + .abstract index
 * + SOP auto-growth (inspired by GenericAgent)
 * + Working Memory Checkpoints
 *
 * ~/.vk-cowork/memory/
 * ├── .abstract              L0 root index (auto-generated manifest)
 * ├── MEMORY.md              long-term memory (P0/P1/P2 lifecycle tags)
 * ├── SESSION-STATE.md       working buffer (cross-session context handoff)
 * ├── daily/                 L2 raw logs (append-only, one file per day)
 * ├── insights/              L1 monthly distillation
 * ├── lessons/               L1 structured lessons
 * ├── sops/                  self-growing SOPs (Standard Operating Procedures)
 * └── archive/               expired P1/P2 items
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, renameSync, unlinkSync, statSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadUserSettings } from "./user-settings.js";

// ─── Paths ──────────────────────────────────────────────────

const MEMORY_ROOT        = join(homedir(), ".vk-cowork", "memory");
const LONG_TERM_FILE     = join(MEMORY_ROOT, "MEMORY.md");
const SESSION_STATE_FILE = join(MEMORY_ROOT, "SESSION-STATE.md");
const ROOT_ABSTRACT      = join(MEMORY_ROOT, ".abstract");
const DAILY_DIR          = join(MEMORY_ROOT, "daily");
const INSIGHTS_DIR       = join(MEMORY_ROOT, "insights");
const LESSONS_DIR        = join(MEMORY_ROOT, "lessons");
const ARCHIVE_DIR        = join(MEMORY_ROOT, "archive");
const SOPS_DIR           = join(MEMORY_ROOT, "sops");

const ALL_DIRS = [MEMORY_ROOT, DAILY_DIR, INSIGHTS_DIR, LESSONS_DIR, ARCHIVE_DIR, SOPS_DIR];

const SEED_MEMORY_MANAGEMENT_SOP = `# Memory Management SOP

本 SOP 定义了记忆系统的管理规则。Agent 可根据实践经验更新此文件。

## 写入前检查清单
- [ ] 信息是否经过实际验证？（未验证的猜测禁止写入）
- [ ] 是否已有类似记录？（优先更新，避免重复）
- [ ] 生命周期标签是否正确？（P0 永久 / P1 90天 / P2 30天）

## MEMORY.md 写入规则
- P0: 用户明确表达的偏好、核心工作原则
- P1: 项目架构决策、技术方案选型、环境配置（90天后过期）
- P2: 临时测试地址、一次性配置、短期任务信息（30天后过期）
- 格式: \`- [P0] 内容\` 或 \`- [P1|expire:YYYY-MM-DD] 内容\`

## SOP 写入规则
- 只为多步骤且踩过坑的任务创建 SOP
- 必须包含: 前置条件、关键步骤、踩坑点、验证方法
- 命名: 动词-对象-目标（如 "部署-nextjs-到-vercel"）

## Daily 写入规则
- 每次会话结束追加摘要（一两句话即可）
- 格式: \`## HH:MM 简述\` + 要点列表

## 禁止写入
- 推理过程和中间思考
- 通用编程知识
- 可轻松复现的操作细节
`;

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

  // Seed memory-management SOP if not exists
  const mmSopPath = join(SOPS_DIR, "memory-management.md");
  if (!existsSync(mmSopPath)) {
    writeFileSync(mmSopPath, SEED_MEMORY_MANAGEMENT_SOP, "utf8");
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
 * Extract the first non-empty, non-heading line from content as a brief summary.
 */
function extractFirstLineSummary(content: string, maxLen = 80): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith(">") && !trimmed.startsWith("---")) {
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
    }
  }
  return "";
}

/**
 * Auto-generate root .abstract from file manifest.
 * Rich index: SOP names+descriptions, daily dates+first-line summaries,
 * MEMORY.md section headings. Agent uses this to decide what to file_read.
 */
export function refreshRootAbstract(): void {
  ensureDirs();

  const memDir = MEMORY_ROOT.replace(/\\/g, "/");

  const dailies = listDailyMemories();
  const recentDailies = dailies.slice(0, 10);

  // Extract headings from MEMORY.md as topic hints
  const lt = readLongTermMemory();
  const headings = (lt.match(/^#+\s+.+/gm) ?? []).slice(0, 10);
  const taggedItems = (lt.match(/^[-*]\s+\[P[012][^\]]*\].{0,60}/gm) ?? []).slice(0, 8);
  const topicLines = headings.length ? headings : taggedItems;

  // Insight files
  const insightFiles = existsSync(INSIGHTS_DIR)
    ? readdirSync(INSIGHTS_DIR).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 5)
    : [];

  const lines: string[] = [
    `# memory index (${memDir})`,
    "",
  ];

  // SOP index (top priority — most actionable)
  const sops = listSops();
  if (sops.length) {
    lines.push("## SOPs (可复用操作流程) — 路径: sops/{名称}.md");
    sops.forEach(s => lines.push(`- ${s.name}: ${s.description || "(no description)"}  [${s.updatedAt}]`));
    lines.push("");
  }

  // Recent daily logs with first-line summaries
  lines.push("## recent daily logs — 路径: daily/{日期}.md");
  if (recentDailies.length) {
    for (const d of recentDailies) {
      const content = readDailyMemory(d.date);
      const summary = extractFirstLineSummary(content);
      lines.push(`- ${d.date}: ${summary || `(${(d.size / 1024).toFixed(1)}KB)`}`);
    }
  } else {
    lines.push("- (empty)");
  }
  lines.push("");

  // Long-term memory sections
  lines.push("## long-term memory sections (MEMORY.md)");
  if (topicLines.length) {
    topicLines.forEach(l => lines.push(l));
  } else {
    lines.push("- (empty)");
  }
  lines.push("");

  if (insightFiles.length) {
    lines.push("## insights (L1) — 路径: insights/{月份}.md");
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

// ─── SOP (Standard Operating Procedures) ─────────────────────

export type SopInfo = {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
  description: string;
};

function sopPath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_");
  return join(SOPS_DIR, `${safeName}.md`);
}

function extractSopDescription(content: string): string {
  const firstLine = content.split("\n").find(l => l.trim() && !l.startsWith("#"));
  if (firstLine) return firstLine.trim().slice(0, 120);
  const heading = content.match(/^#+\s+(.+)/m);
  return heading ? heading[1].trim().slice(0, 120) : "";
}

export function readSop(name: string): string {
  ensureDirs();
  const p = sopPath(name);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

export function writeSop(name: string, content: string): void {
  ensureDirs();
  atomicWrite(sopPath(name), content);
  try { refreshRootAbstract(); } catch { /* non-blocking */ }
}

export function deleteSop(name: string): boolean {
  const p = sopPath(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  try { refreshRootAbstract(); } catch { /* non-blocking */ }
  return true;
}

export function listSops(): SopInfo[] {
  ensureDirs();
  if (!existsSync(SOPS_DIR)) return [];
  return readdirSync(SOPS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const p = join(SOPS_DIR, f);
      const content = readFileSync(p, "utf8");
      const stat = statSync(p);
      return {
        name: f.replace(".md", ""),
        path: p,
        size: Buffer.byteLength(content, "utf8"),
        updatedAt: localDateStr(stat.mtime),
        description: extractSopDescription(content),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function searchSops(query: string): SopInfo[] {
  if (!query.trim()) return listSops();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return listSops().filter(sop => {
    const text = (sop.name + " " + sop.description).toLowerCase();
    return terms.some(term => text.includes(term));
  });
}

// ─── Working Memory (per-session structured checkpoint) ──────

export function readWorkingMemory(): string {
  return readSessionState();
}

export function writeWorkingMemory(checkpoint: {
  keyInfo: string;
  currentTask?: string;
  relatedSops?: string[];
  history?: string[];
}): void {
  const lines: string[] = [
    `# Working Memory Checkpoint`,
    `> Updated: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
  ];
  if (checkpoint.currentTask) {
    lines.push(`## 当前任务`, checkpoint.currentTask, "");
  }
  if (checkpoint.keyInfo) {
    lines.push(`## 关键上下文`, checkpoint.keyInfo, "");
  }
  if (checkpoint.relatedSops?.length) {
    lines.push(`## 相关 SOP`, ...checkpoint.relatedSops.map(s => `- ${s}`), "");
  }
  if (checkpoint.history?.length) {
    lines.push(`## 操作历史`, ...checkpoint.history.slice(-20).map(h => `- ${h}`), "");
  }
  writeSessionState(lines.join("\n"));
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

// ─── Context assembly ─────────────────────────────────────────

const MEMORY_PROTOCOL = `
[记忆系统规则]
你拥有跨会话的持久记忆能力。上面 <memory> 标签内包含目录索引和核心记忆。

━━ 记忆层级 ━━
- L0: ~/.vk-cowork/memory/.abstract              目录索引（已注入，用于定位文件）
- L1: ~/.vk-cowork/memory/insights/YYYY-MM.md    月度提炼要点
- L2: ~/.vk-cowork/memory/daily/YYYY-MM-DD.md    原始日志，append-only
- SOP: ~/.vk-cowork/memory/sops/*.md             可复用操作流程（自主生长）

━━ 按需加载规则（重要）━━
<memory> 中只包含目录索引、MEMORY.md、工作记忆和今日笔记。
如需更多历史信息，根据目录索引中的摘要判断相关性，主动用文件读取工具加载：
- 看到相关 SOP 名称 → 读取 ~/.vk-cowork/memory/sops/{名称}.md
- 看到相关历史日期 → 读取 ~/.vk-cowork/memory/daily/{日期}.md
- 看到 insights 条目 → 读取 ~/.vk-cowork/memory/insights/{月份}.md
不要猜测记忆内容，先读取再行动。按需加载比盲目搜索更高效。

━━ 写入规则 ━━
写入 ~/.vk-cowork/memory/MEMORY.md（用文件编辑工具）：
  [P0]                    用户偏好、核心原则（永久）
  [P1|expire:YYYY-MM-DD]  活跃项目决策和技术方案（90 天后过期）
  [P2|expire:YYYY-MM-DD]  临时信息如测试地址、配置（30 天后过期）

追加到 ~/.vk-cowork/memory/daily/今日日期.md：
  当日事件、完成的任务、新发现的问题

━━ SOP 自进化规则（重要）━━
当你完成一个复杂任务（多步骤、踩过坑、有关键决策点）时，用 save_sop 工具将流程沉淀为 SOP：
- SOP 应记录：前置条件、关键步骤、踩坑点、验证方法
- 只记录经过实践验证的流程，不要记录未验证的猜测
- SOP 名称用简短的任务描述（如 "部署-nextjs-到-vercel"、"配置-github-actions"）
- 如果已有相关 SOP，优先更新而非新建
- 执行新任务前先检查目录索引中的 SOP 列表，避免重复劳动

━━ Working Memory 规则 ━━
执行长任务时，用 save_working_memory 工具保存关键上下文：
- 当前任务目标和进展
- 关键中间结果和决策
- 相关 SOP 名称（方便下次快速回忆）
这些信息会在下次会话中自动加载，确保跨会话连续性。

━━ 执行纪律 ━━
- 如果连续 5 次以上工具调用都在处理同一个错误，必须停下来切换策略：
  1. 重新审视问题本质，检查是否遗漏了前置条件
  2. 搜索相关 SOP 看是否有已知解法
  3. 如果仍无进展，用 AskUserQuestion 请求用户协助
- 禁止对同一个失败操作无脑重试超过 3 次
- 执行复杂任务时，每完成一个关键阶段就用 save_working_memory 保存进度

━━ 会话结束前的责任（重要）━━
每次完成用户最后一个任务后，调用 distill_memory 工具触发结构化记忆蒸馏，
或手动完成以下操作，不要等用户提醒：
1. 把新的用户偏好/决策写入 MEMORY.md，按 [P0]/[P1]/[P2] 标注
2. 把本次会话摘要（做了什么、决定了什么）追加写入 daily/今日.md
3. 如有未完成任务或下次需继续的上下文，用 save_working_memory 更新工作记忆
4. 如果解决了复杂任务，用 save_sop 将流程沉淀为可复用 SOP

过期的 P1/P2 条目会被后台 janitor 自动归档到 archive/，无需手动处理。
`.trim();

/**
 * Build a slim memory context for the given prompt.
 *
 * Strategy (GenericAgent-inspired): inject only the directory index and
 * core memory. The Agent decides what else to file_read based on the index.
 *
 * Injected:
 *   1. User profile / global prompt (personalization)
 *   2. .abstract (rich directory index with summaries)
 *   3. MEMORY.md (long-term core preferences/decisions — always relevant)
 *   4. SESSION-STATE.md (cross-session working memory)
 *   5. Today's daily note (immediate context)
 *
 * NOT injected (Agent loads on-demand via file_read):
 *   - Yesterday's / historical daily logs
 *   - Full SOP content (names+descriptions are in .abstract)
 *   - Insight files
 */
export function buildSmartMemoryContext(prompt: string): string {
  ensureDirs();

  // Ensure .abstract is up-to-date
  try { refreshRootAbstract(); } catch { /* non-blocking */ }

  const todayDate = localDateStr();

  const abstract = readAbstract(MEMORY_ROOT).trim();
  const longTerm = readLongTermMemory().trim();
  const sessionState = readSessionState().trim();
  const todayContent = readDailyMemory(todayDate).trim();

  // Inject personalization from user settings
  const preamble: string[] = [];
  try {
    const settings = loadUserSettings();
    const profileLines: string[] = [];
    if (settings.userName?.trim()) profileLines.push(`- 姓名: ${settings.userName.trim()}`);
    if (settings.workDescription?.trim()) profileLines.push(`- 工作描述: ${settings.workDescription.trim()}`);
    if (profileLines.length) {
      preamble.push("[用户档案]", ...profileLines, "");
    }
    if (settings.globalPrompt?.trim()) {
      preamble.push("[全局指令]", settings.globalPrompt.trim(), "");
    }
  } catch { /* ignore — settings unavailable */ }

  const parts: string[] = [...preamble, "<memory>"];

  if (abstract) {
    parts.push("## 记忆目录索引");
    parts.push(abstract);
    parts.push("");
  }
  if (longTerm) {
    parts.push("## 长期记忆 (MEMORY.md)");
    parts.push(longTerm);
    parts.push("");
  }
  if (sessionState) {
    parts.push("## 工作记忆 (SESSION-STATE.md)");
    parts.push(sessionState);
    parts.push("");
  }
  if (todayContent) {
    parts.push(`## 今日笔记 (${todayDate})`);
    parts.push(todayContent);
    parts.push("");
  }

  if (parts.length <= preamble.length + 1) {
    parts.push("（暂无历史记忆）");
  }

  parts.push("</memory>");
  parts.push("");
  parts.push(MEMORY_PROTOCOL);

  return parts.join("\n");
}

/** Legacy alias — kept for backward compat */
export function buildMemoryContext(): string {
  return buildSmartMemoryContext("");
}
