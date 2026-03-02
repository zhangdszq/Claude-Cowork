/**
 * Telegram Bot Service (grammY)
 *
 * Mirrors the DingTalk/Feishu bot architecture:
 * - Long polling via grammY (with optional proxy)
 * - Access control: dmPolicy (open/allowlist), groupPolicy (open/allowlist/mention)
 * - Message deduplication (5-min TTL)
 * - Media handling: photos, voice, documents, video
 * - Claude Agent SDK query() with shared MCP + per-session MCP
 * - Codex provider support
 * - Session/memory sync with in-app session store
 * - Conversation history (last N turns)
 * - Dynamic session title generation
 * - Proactive messaging
 * - Telegram HTML formatting + message chunking (4096 char limit)
 */
import { Bot, GrammyError, HttpError, type Context } from "grammy";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EventEmitter } from "events";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { loadUserSettings } from "./user-settings.js";
import { getCodexBinaryPath } from "./codex-runner.js";
import { buildSmartMemoryContext, recordConversation, getRecentConversationBlocks } from "./memory-store.js";
import { getEnhancedEnv, getClaudeCodePath } from "./util.js";
import { getSettingSources } from "./claude-settings.js";
import type { SessionStore } from "./session-store.js";
import { createSharedMcpServer } from "./shared-mcp.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramBotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface TelegramBotOptions {
  token: string;
  proxy?: string;
  assistantId: string;
  assistantName: string;
  persona?: string;
  coreValues?: string;
  relationship?: string;
  cognitiveStyle?: string;
  operatingGuidelines?: string;
  userContext?: string;
  provider?: "claude" | "codex";
  model?: string;
  defaultCwd?: string;
  dmPolicy?: "open" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  /** Require @mention in groups before responding */
  requireMention?: boolean;
  /** Owner Telegram user IDs for proactive messaging */
  ownerUserIds?: string[];
  /** Skill names configured for the assistant */
  skillNames?: string[];
}

interface ConvMessage {
  role: "user" | "assistant";
  content: string;
}

interface StreamResult {
  text: string;
  draftMessageId: number | null;
}

// ─── Streaming helpers ───────────────────────────────────────────────────────

function extractPartialText(message: Record<string, unknown>): string | null {
  const msg = message?.message as Record<string, unknown> | undefined;
  if (!msg?.content || !Array.isArray(msg.content)) return null;
  const texts = (msg.content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!);
  return texts.length > 0 ? texts.join("") : null;
}

const DRAFT_THROTTLE_MS = 1500;
const DRAFT_SUFFIX = "\n\n⏳ ...";
const HEARTBEAT_INTERVAL_MS = 60_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// ─── Skill info loader ───────────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  label: string;
  description: string;
}

interface SkillCatalogEntry {
  name: string;
  label?: string;
  description?: string;
}

let _catalogCache: SkillCatalogEntry[] | null = null;
let _catalogMtime = 0;

function loadSkillCatalog(): SkillCatalogEntry[] {
  const catalogPath = join(__dirname, "..", "..", "..", "skills-catalog.json");
  try {
    const st = statSync(catalogPath);
    if (_catalogCache && st.mtimeMs === _catalogMtime) return _catalogCache;
    const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
    _catalogCache = (raw?.skills ?? []) as SkillCatalogEntry[];
    _catalogMtime = st.mtimeMs;
    return _catalogCache;
  } catch {
    return _catalogCache ?? [];
  }
}

function loadInstalledSkills(): Map<string, SkillInfo> {
  const result = new Map<string, SkillInfo>();
  const catalog = loadSkillCatalog();
  const catalogMap = new Map(catalog.map((s) => [s.name, s]));

  const skillsDirs = [
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".cursor", "skills"),
    join(homedir(), ".codex", "skills"),
  ];

  for (const dir of skillsDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".") || result.has(name)) continue;
        const skillDir = join(dir, name);
        if (!statSync(skillDir).isDirectory()) continue;
        if (!existsSync(join(skillDir, "SKILL.md"))) continue;

        const catalogEntry = catalogMap.get(name);
        const label = catalogEntry?.label ?? name;
        let desc = catalogEntry?.description ?? "";

        if (!desc) {
          try {
            const content = readFileSync(join(skillDir, "SKILL.md"), "utf8");
            const firstLine = content.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
            desc = firstLine?.trim().slice(0, 200) ?? "";
          } catch { /* ignore */ }
        }

        result.set(name, { name, label, description: desc });
      }
    } catch { /* ignore */ }
  }

  return result;
}

function loadSkillContent(skillName: string): string | null {
  const dirs = [
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".cursor", "skills"),
    join(homedir(), ".codex", "skills"),
  ];
  for (const dir of dirs) {
    const filePath = join(dir, skillName, "SKILL.md");
    if (existsSync(filePath)) {
      try { return readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    }
  }
  return null;
}

// ─── Conversation history context (for fresh sessions) ───────────────────────

// Regex to detect absolute file paths that indicate file-analysis assistant replies.
const FILE_PATH_RE = /\/(?:tmp|var\/folders|private\/var|home|Users)\/\S+\.\w{2,6}/i;

function buildHistoryContext(history: ConvMessage[], assistantId?: string): string {
  // Primary: parse today's daily log for full Q&A pairs (persists across restarts).
  if (assistantId) {
    const fromLog = getRecentConversationBlocks(assistantId, 4);
    if (fromLog) return fromLog;
  }

  // Fallback: in-memory history — include both roles, filter file-analysis replies.
  if (!history.length) return "";
  const lines = history.slice(-8).map((m) => {
    const label = m.role === "user" ? "用户" : "助手";
    if (m.role === "assistant" && FILE_PATH_RE.test(m.content)) {
      return `${label}: [对某文件进行了分析，内容已省略]`;
    }
    const content = m.content.length > 400 ? m.content.slice(0, 400) + "…" : m.content;
    return `${label}: ${content}`;
  });
  if (!lines.length) return "";
  return [
    "## 近期对话上下文（仅供参考）",
    "⚠️ 如历史中出现文件路径，那是以前的文件，与当前任务无关。",
    lines.join("\n"),
  ].join("\n");
}

// ─── Structured persona builder ──────────────────────────────────────────────

function buildStructuredPersona(
  opts: TelegramBotOptions,
  ...extras: (string | undefined | null)[]
): string {
  const sections: string[] = [];
  const nameLine = `你的名字是「${opts.assistantName}」。`;
  const p = opts.persona?.trim();
  if (p) sections.push(`## 你的身份\n${nameLine}\n${p}`);
  else sections.push(`## 你的身份\n${nameLine}\n你是一个智能助手，请简洁有用地回答问题。`);
  if (opts.coreValues?.trim()) sections.push(`## 核心价值观\n${opts.coreValues.trim()}`);
  if (opts.relationship?.trim()) sections.push(`## 与用户的关系\n${opts.relationship.trim()}`);
  if (opts.cognitiveStyle?.trim()) sections.push(`## 你的思维方式\n${opts.cognitiveStyle.trim()}`);
  if (opts.operatingGuidelines?.trim()) sections.push(`## 操作规程\n${opts.operatingGuidelines.trim()}`);
  if (opts.userContext?.trim()) sections.push(`## 关于用户\n${opts.userContext.trim()}`);

  const normalized = (opts.skillNames ?? []).map((s) => s.trim()).filter(Boolean);
  if (normalized.length > 0) {
    sections.push(`## 可用技能\n用户可通过 /<技能名> 调用以下技能：\n${normalized.map((s) => `/${s}`).join("\n")}`);
  }

  for (const extra of extras) {
    if (extra?.trim()) sections.push(extra.trim());
  }
  return sections.join("\n\n");
}

// ─── Message deduplication ────────────────────────────────────────────────────

const DEDUP_TTL_MS = 5 * 60 * 1000;
const processedMsgs = new Map<string, number>();

function isDuplicate(key: string): boolean {
  const ts = processedMsgs.get(key);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) {
    processedMsgs.delete(key);
    return false;
  }
  return true;
}

function markProcessed(key: string): void {
  processedMsgs.set(key, Date.now());
  if (processedMsgs.size > 5000) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, ts] of processedMsgs) {
      if (ts < cutoff) processedMsgs.delete(k);
    }
  }
}

// ─── Access control ───────────────────────────────────────────────────────────

function isAllowed(ctx: Context, opts: TelegramBotOptions): boolean {
  const chatType = ctx.chat?.type;
  const isGroup = chatType === "group" || chatType === "supergroup";
  const userId = String(ctx.from?.id ?? "");

  if (isGroup) {
    if ((opts.groupPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      const chatId = String(ctx.chat?.id ?? "");
      if (!allowed.includes(chatId) && !allowed.includes(userId)) {
        console.log(`[Telegram] Group ${chatId} / user ${userId} blocked by groupPolicy=allowlist`);
        return false;
      }
    }
  } else {
    if ((opts.dmPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      if (!userId || !allowed.includes(userId)) {
        console.log(`[Telegram] User ${userId} blocked by dmPolicy=allowlist`);
        return false;
      }
    }
  }
  return true;
}

// ─── Mention detection ────────────────────────────────────────────────────────

function isMentioned(ctx: Context, botUsername: string): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? [];
  for (const entity of entities) {
    if (entity.type === "mention") {
      const text = ctx.message?.text ?? ctx.message?.caption ?? "";
      const mention = text.substring(entity.offset, entity.offset + entity.length);
      if (mention.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
    }
  }
  return false;
}

// ─── Markdown to Telegram HTML conversion ─────────────────────────────────────

function markdownToTelegramHtml(text: string): string {
  // Phase 1: stash code blocks and inline code before HTML-escaping plain text,
  // so their content is escaped once and the tags themselves aren't double-escaped.
  const blocks: string[] = [];
  const inlines: string[] = [];

  let result = text;

  result = result.replace(/```(\w+)?\n?([\s\S]*?)```/gs, (_m, _lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
    return `\x02B${idx}\x03`;
  });

  result = result.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlines.length;
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `\x02I${idx}\x03`;
  });

  // Phase 2: escape remaining plain text so raw < > & don't break parse_mode HTML.
  result = escapeHtml(result);

  // Phase 3: apply Markdown → Telegram HTML conversions on now-safe text.
  // Headings → bold (Telegram has no heading tags)
  result = result.replace(/^#{1,2} (.+)$/gm, "<b>$1</b>");
  result = result.replace(/^### (.+)$/gm, "<b>$1</b>");
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
  // Italic (avoid matching bold **)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  result = result.replace(/(?<!_)_(?!_)([^_\n]+?)(?<!_)_(?!_)/g, "<i>$1</i>");
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Horizontal rule → Unicode line
  result = result.replace(/^---+$/gm, "──────────────");

  // Phase 4: restore stashed code blocks and inline code.
  result = result.replace(/\x02B(\d+)\x03/g, (_m, i) => blocks[parseInt(i)]);
  result = result.replace(/\x02I(\d+)\x03/g, (_m, i) => inlines[parseInt(i)]);

  return result;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Message chunking (Telegram 4096 char limit) ──────────────────────────────

const TG_MESSAGE_LIMIT = 4096;

function chunkMessage(text: string): string[] {
  if (text.length <= TG_MESSAGE_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MESSAGE_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", TG_MESSAGE_LIMIT);
    if (splitAt < TG_MESSAGE_LIMIT * 0.3) {
      splitAt = remaining.lastIndexOf(" ", TG_MESSAGE_LIMIT);
    }
    if (splitAt < TG_MESSAGE_LIMIT * 0.3) {
      splitAt = TG_MESSAGE_LIMIT;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

// ─── Status emitter ───────────────────────────────────────────────────────────

const statusEmitter = new EventEmitter();

export function onTelegramBotStatusChange(
  cb: (assistantId: string, status: TelegramBotStatus, detail?: string) => void,
): () => void {
  statusEmitter.on("status", cb);
  return () => statusEmitter.off("status", cb);
}

function emitStatus(assistantId: string, status: TelegramBotStatus, detail?: string) {
  statusEmitter.emit("status", assistantId, status, detail);
}

// ─── Session update emitter ───────────────────────────────────────────────────

const sessionUpdateEmitter = new EventEmitter();

export function onTelegramSessionUpdate(
  cb: (sessionId: string, updates: { title?: string; status?: string }) => void,
): () => void {
  sessionUpdateEmitter.on("update", cb);
  return () => sessionUpdateEmitter.off("update", cb);
}

function emitSessionUpdate(sessionId: string, updates: { title?: string; status?: string }) {
  sessionStore?.updateSession(sessionId, updates as Parameters<SessionStore["updateSession"]>[1]);
  sessionUpdateEmitter.emit("update", sessionId, updates);
}

// ─── Injected session store ───────────────────────────────────────────────────

let sessionStore: SessionStore | null = null;

export function setTelegramSessionStore(store: SessionStore): void {
  sessionStore = store;
}

// ─── Connection pool ──────────────────────────────────────────────────────────

const pool = new Map<string, TelegramConnection>();

export async function startTelegramBot(opts: TelegramBotOptions): Promise<void> {
  stopTelegramBot(opts.assistantId);
  const conn = new TelegramConnection(opts);
  pool.set(opts.assistantId, conn);
  await conn.start();
}

export function stopTelegramBot(assistantId: string): void {
  const conn = pool.get(assistantId);
  if (conn) {
    conn.stop();
    pool.delete(assistantId);
  }
  emitStatus(assistantId, "disconnected");
}

export function getTelegramBotStatus(assistantId: string): TelegramBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

export function updateTelegramBotConfig(
  assistantId: string,
  updates: Partial<Pick<TelegramBotOptions, "provider" | "model" | "persona" | "coreValues" | "relationship" | "cognitiveStyle" | "operatingGuidelines" | "userContext" | "assistantName" | "defaultCwd" | "skillNames">>,
): void {
  const conn = pool.get(assistantId);
  if (!conn) return;
  const prevSkills = conn.opts.skillNames;
  Object.assign(conn.opts, updates);
  if (updates.skillNames && JSON.stringify(updates.skillNames) !== JSON.stringify(prevSkills)) {
    conn.refreshCommands().catch((err) => console.warn("[Telegram] Failed to refresh commands:", err));
  }
  console.log(`[Telegram] Config updated for assistant=${assistantId}:`, Object.keys(updates));
}

// ─── Proactive messaging ──────────────────────────────────────────────────────

export async function sendProactiveTelegramMessage(
  assistantId: string,
  text: string,
  opts?: { targets?: string[]; title?: string },
): Promise<{ ok: boolean; error?: string }> {
  const conn = pool.get(assistantId);
  if (!conn) {
    return { ok: false, error: `Telegram Bot (${assistantId}) 未连接` };
  }
  return conn.sendProactive(text, opts?.targets);
}

// ─── Conversation history & session management ────────────────────────────────

const histories = new Map<string, ConvMessage[]>();
const MAX_TURNS = 10;
const botSessionIds = new Map<string, string>();
const titledSessions = new Map<string, number>();

function getHistory(key: string): ConvMessage[] {
  if (!histories.has(key)) histories.set(key, []);
  return histories.get(key)!;
}

function getBotSession(
  assistantId: string,
  chatId: string,
  assistantName: string,
  provider: "claude" | "codex",
  model: string | undefined,
  cwd: string | undefined,
): string {
  const key = `${assistantId}:${chatId}`;
  if (botSessionIds.has(key)) return botSessionIds.get(key)!;
  if (!sessionStore) throw new Error("[Telegram] SessionStore not injected");
  const session = sessionStore.createSession({
    title: `[Telegram] ${assistantName}`,
    assistantId,
    provider,
    model,
    cwd,
  });
  botSessionIds.set(key, session.id);
  return session.id;
}

async function updateBotSessionTitle(
  sessionId: string,
  history: ConvMessage[],
  prefix = "[Telegram]",
): Promise<void> {
  const turns = Math.floor(history.length / 2);
  const prevCount = titledSessions.get(sessionId) ?? 0;
  const shouldUpdate = turns === 1 || (turns === 3 && prevCount < 2);
  if (!shouldUpdate) return;
  titledSessions.set(sessionId, prevCount + 1);

  const recentTurns = history.slice(-6);
  const contextLines = recentTurns
    .map((m) => {
      const role = m.role === "user" ? "用户" : "助手";
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${role}：${text.slice(0, 200)}`;
    })
    .join("\n");

  const fallback = (recentTurns[0]
    ? (typeof recentTurns[0].content === "string" ? recentTurns[0].content : "对话")
    : "对话"
  ).slice(0, 30).trim();

  try {
    const agentSdk = await import("@anthropic-ai/claude-agent-sdk");
    const result = await agentSdk.unstable_v2_prompt(
      `请根据以下对话内容，生成一个简短的中文标题（不超过12字，不加引号，不加标点），直接输出标题，不输出其他内容：\n\n${contextLines}`,
      { model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514" } as Parameters<typeof agentSdk.unstable_v2_prompt>[1],
    );
    const generated = result.subtype === "success" && result.result ? result.result.trim() : "";
    const title = (generated && generated !== "New Session") ? generated : fallback;
    emitSessionUpdate(sessionId, { title: `${prefix} ${title}` });
    console.log(`[Telegram] Session title updated (turn ${turns}): "${title}"`);
  } catch (err) {
    console.warn(`[Telegram] Title generation failed:`, err);
    if (prevCount === 0) {
      emitSessionUpdate(sessionId, { title: `${prefix} ${fallback}` });
    }
  }
}

// ─── Claude session ID registry (for query() resume) ─────────────────────────

const botClaudeSessionIds = new Map<string, string>();

function getBotClaudeSessionId(key: string): string | undefined {
  return botClaudeSessionIds.get(key);
}

function setBotClaudeSessionId(key: string, claudeSessionId: string): void {
  botClaudeSessionIds.set(key, claudeSessionId);
  const appSessionId = botSessionIds.get(key);
  if (appSessionId && sessionStore) {
    sessionStore.updateSession(appSessionId, { claudeSessionId });
  }
}

function buildQueryEnv(): Record<string, string | undefined> {
  const settings = loadUserSettings();
  const apiKey =
    settings.anthropicAuthToken ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    "";
  const baseURL = settings.anthropicBaseUrl || "";

  return {
    ...getEnhancedEnv(),
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: apiKey } : {}),
    ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
  };
}

// ─── Media extraction ─────────────────────────────────────────────────────────

async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  proxyUrl?: string,
  originalName?: string,
): Promise<string | null> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;

    const token = bot.token;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    let resp: Response;
    if (proxyUrl) {
      const undici = await import("undici");
      const dispatcher = new undici.ProxyAgent(proxyUrl);
      resp = await undici.fetch(url, { dispatcher }) as unknown as Response;
    } else {
      resp = await fetch(url);
    }
    if (!resp.ok) return null;

    const buffer = Buffer.from(await resp.arrayBuffer());

    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    // Prefer original filename to preserve context; fall back to Telegram's ext
    let fileName: string;
    if (originalName) {
      const safeName = originalName.replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
      fileName = `vk-tg-${Date.now()}-${safeName}`;
    } else {
      const ext = file.file_path.split(".").pop() ?? "bin";
      fileName = `vk-tg-${Date.now()}.${ext}`;
    }

    const tmpPath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(tmpPath, buffer);
    console.log(`[Telegram] File saved: ${tmpPath} (${(buffer.length / 1024).toFixed(1)}KB)`);
    return tmpPath;
  } catch (err) {
    console.error(`[Telegram] File download error:`, err);
    return null;
  }
}

// ─── TelegramConnection ──────────────────────────────────────────────────────

class TelegramConnection {
  status: TelegramBotStatus = "disconnected";
  opts: TelegramBotOptions;
  private bot: Bot | null = null;
  private stopped = false;
  private inflight = new Set<string>();
  private botUsername = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private effectiveProxyUrl: string | undefined = undefined;

  constructor(opts: TelegramBotOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.clearTimers();
    this.status = "connecting";
    emitStatus(this.opts.assistantId, "connecting");

    try {
      const botConfig: ConstructorParameters<typeof Bot>[1] = {};

      const proxyUrl = this.opts.proxy
        || process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY
        || process.env.all_proxy || process.env.ALL_PROXY
        || undefined;

      this.effectiveProxyUrl = proxyUrl;

      let proxyDispatcher: import("undici").Dispatcher | undefined;
      if (proxyUrl) {
        const undici = await import("undici");
        proxyDispatcher = new undici.ProxyAgent(proxyUrl);
        console.log(`[Telegram] Using proxy: ${proxyUrl}`);
      }

      this.bot = new Bot(this.opts.token, botConfig);

      // Electron's built-in fetch ignores undici dispatcher, so we intercept
      // all grammY API calls and route them through undici.fetch + ProxyAgent.
      if (proxyDispatcher) {
        const dispatcher = proxyDispatcher;
        const undiciModule = await import("undici");
        this.bot.api.config.use(async (_prev, method, payload, signal) => {
          const url = `https://api.telegram.org/bot${this.bot!.token}/${method}`;
          const body = payload !== undefined ? JSON.stringify(payload) : undefined;
          if (method !== "getUpdates") {
            console.log(`[Telegram] API call: ${method}`);
          }
          // Bridge AbortSignal: Electron's AbortSignal is incompatible with undici's,
          // so create a fresh controller and wire up the abort event.
          let fetchSignal: AbortSignal | undefined;
          if (signal) {
            if (signal.aborted) {
              throw new DOMException("The operation was aborted.", "AbortError");
            }
            const ac = new AbortController();
            signal.addEventListener("abort", () => ac.abort((signal as any).reason), { once: true });
            fetchSignal = ac.signal;
          }
          try {
            const resp = await undiciModule.fetch(url, {
              method: "POST",
              headers: body ? { "Content-Type": "application/json" } : undefined,
              body,
              dispatcher,
              signal: fetchSignal,
            });
            const json = await resp.json() as any;
            if (!json.ok && method !== "getUpdates") {
              console.error(`[Telegram] API error ${method}:`, json.description);
            }
            return json;
          } catch (err) {
            console.error(`[Telegram] API fetch error ${method}:`, err instanceof Error ? err.message : err);
            throw err;
          }
        });
      }

      const me = await this.bot.api.getMe();
      this.botUsername = me.username ?? "";
      console.log(`[Telegram] Authenticated as @${this.botUsername}`);

      await this.registerCommands();
      this.setupHandlers();

      this.bot.start({
        onStart: () => {
          this.reconnectAttempts = 0;
          this.status = "connected";
          emitStatus(this.opts.assistantId, "connected");
          console.log(`[Telegram] Connected: assistant=${this.opts.assistantId} bot=@${this.botUsername}`);
        },
      });

      this.status = "connected";
      emitStatus(this.opts.assistantId, "connected");
      this.startHeartbeat();
    } catch (err) {
      this.status = "error";
      const detail = err instanceof Error ? err.message : String(err);
      emitStatus(this.opts.assistantId, "error", detail);
      throw err;
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.bot) {
      try { this.bot.stop(); } catch { /* ignore */ }
      this.bot = null;
    }
    this.status = "disconnected";
  }

  // ── Auto-reconnect ─────────────────────────────────────────────────────────

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (this.stopped || !this.bot) return;
      try {
        await this.bot.api.getMe();
      } catch (err) {
        console.warn("[Telegram] Heartbeat failed:", err instanceof Error ? err.message : err);
        if (!this.stopped) this.scheduleReconnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.clearTimers();

    const jitter = Math.random() * 0.25;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts) * (1 + jitter), RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    console.log(`[Telegram] Scheduling reconnect in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    this.status = "connecting";
    emitStatus(this.opts.assistantId, "connecting", `重连中 (${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        if (this.bot) { try { this.bot.stop(); } catch { /* ignore */ } this.bot = null; }
        await this.start();
      } catch (err) {
        console.error("[Telegram] Reconnect failed:", err instanceof Error ? err.message : err);
        if (!this.stopped) this.scheduleReconnect();
      }
    }, delay);
  }

  async refreshCommands(): Promise<void> {
    return this.registerCommands();
  }

  private async registerCommands(): Promise<void> {
    if (!this.bot) return;
    try {
      const builtinCmds = [
        { command: "start", description: "开始对话 / 查看欢迎信息" },
        { command: "myid", description: "查看你的 Telegram ID" },
        { command: "new", description: "重置当前对话" },
        { command: "skills", description: "查看可用技能列表" },
      ];

      const skillCmds: { command: string; description: string }[] = [];
      const skillNames = this.opts.skillNames ?? [];
      if (skillNames.length > 0) {
        const installed = loadInstalledSkills();
        for (const name of skillNames) {
          const info = installed.get(name);
          const cmd = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
          const desc = (info?.label ?? name).slice(0, 256);
          skillCmds.push({ command: cmd, description: desc });
        }
      }

      const allCmds = [...builtinCmds, ...skillCmds].slice(0, 100);
      await this.bot.api.setMyCommands(allCmds);
      console.log(`[Telegram] Commands registered: ${builtinCmds.length} builtin + ${skillCmds.length} skills`);
    } catch (err) {
      console.warn(`[Telegram] Failed to register commands:`, err);
    }
  }

  // ── Status reactions ─────────────────────────────────────────────────────────

  private async setReaction(chatId: number | string, messageId: number, emoji: string | null): Promise<void> {
    if (!this.bot) return;
    try {
      if (emoji) {
        await this.bot.api.setMessageReaction(
          Number(chatId), messageId,
          [{ type: "emoji", emoji: emoji as any }],  // eslint-disable-line @typescript-eslint/no-explicit-any
        );
      } else {
        await this.bot.api.setMessageReaction(Number(chatId), messageId, []);
      }
    } catch {
      // Silently ignore — reactions may not be supported in this chat
    }
  }

  async sendProactive(text: string, targets?: string[]): Promise<{ ok: boolean; error?: string }> {
    if (!this.bot) return { ok: false, error: "Bot 未启动" };

    const chatIds = targets?.length ? targets : (this.opts.ownerUserIds ?? []);
    if (chatIds.length === 0) {
      return { ok: false, error: "未指定接收者，请在配置中填写 ownerUserIds" };
    }

    const errors: string[] = [];
    for (const chatId of chatIds) {
      try {
        const chunks = chunkMessage(text);
        for (const chunk of chunks) {
          await this.bot.api.sendMessage(chatId, markdownToTelegramHtml(chunk), {
            parse_mode: "HTML",
          });
        }
      } catch (err) {
        errors.push(`${chatId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errors.length === chatIds.length) {
      return { ok: false, error: errors.join("; ") };
    }
    return { ok: true };
  }

  // ── Handler setup ────────────────────────────────────────────────────────────

  private setupHandlers(): void {
    if (!this.bot) return;

    this.bot.on("message", async (ctx) => {
      if (this.stopped) return;
      try {
        await this.handleMessage(ctx);
      } catch (err) {
        console.error("[Telegram] Message handling error:", err);
      }
    });

    this.bot.catch((err) => {
      const ctx = err.ctx;
      console.error(`[Telegram] Error for update ${ctx.update.update_id}:`);
      const e = err.error;
      if (e instanceof GrammyError) {
        console.error("[Telegram] API error:", e.description);
      } else if (e instanceof HttpError) {
        console.error("[Telegram] Network error:", e);
      } else {
        console.error("[Telegram] Unknown error:", e);
      }
    });
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private async handleMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    // Skip bot's own messages
    if (msg.from?.is_bot) return;

    const messageId = String(msg.message_id);
    const chatId = String(msg.chat.id);
    const chatType = msg.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";

    // Deduplication
    const dedupKey = `tg:${this.opts.assistantId}:${chatId}:${messageId}`;
    if (isDuplicate(dedupKey) || this.inflight.has(dedupKey)) {
      return;
    }
    markProcessed(dedupKey);
    this.inflight.add(dedupKey);

    try {
      // Access control
      if (!isAllowed(ctx, this.opts)) return;

      // Mention gating for groups
      if (isGroup && this.opts.requireMention !== false) {
        if (!isMentioned(ctx, this.botUsername)) {
          // Check if it's a reply to the bot
          const replyToBot = msg.reply_to_message?.from?.username?.toLowerCase() === this.botUsername.toLowerCase();
          if (!replyToBot) return;
        }
      }

      // Extract content
      const extracted = await this.extractContent(ctx);
      if (!extracted.text) return;

      // Built-in commands
      const cmdText = extracted.text.trim();
      if (cmdText === "/start") {
        const userId = msg.from?.id ?? "未知";
        const username = msg.from?.username ? `@${msg.from.username}` : "无";
        const skillNames = this.opts.skillNames ?? [];
        let skillLines = "";
        if (skillNames.length > 0) {
          const installed = loadInstalledSkills();
          const lines = skillNames.map((name) => {
            const info = installed.get(name);
            const cmd = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
            return `/${cmd} — ${info?.label ?? name}`;
          });
          skillLines = `\n\n<b>可用技能：</b>\n${lines.join("\n")}`;
        }
        await ctx.reply(
          `你好！我是 <b>${escapeHtml(this.opts.assistantName)}</b>，你的 AI 助手。\n\n` +
          `你的 Telegram ID: <code>${userId}</code>\n用户名: ${username}\n\n` +
          `直接发消息给我开始聊天吧！\n\n` +
          `<b>可用命令：</b>\n` +
          `/new — 重置对话\n` +
          `/myid — 查看你的 ID\n` +
          `/skills — 查看可用技能` +
          skillLines,
          { parse_mode: "HTML" },
        );
        return;
      }
      if (cmdText === "/myid") {
        const userId = msg.from?.id ?? "未知";
        const username = msg.from?.username ? `@${msg.from.username}` : "无";
        await ctx.reply(
          `你的 Telegram ID: <code>${userId}</code>\n用户名: ${username}\n群组 ID: <code>${chatId}</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      if (cmdText === "/new" || cmdText === "/reset") {
        const historyKey = `${this.opts.assistantId}:${chatId}`;
        histories.delete(historyKey);
        botClaudeSessionIds.delete(historyKey);
        botSessionIds.delete(historyKey);
        await ctx.reply("对话已重置，开始新的对话吧！");
        return;
      }
      if (cmdText === "/skills") {
        const skillNames = this.opts.skillNames ?? [];
        if (skillNames.length === 0) {
          await ctx.reply("当前助手未配置任何技能。\n可在「助手管理」中添加技能。");
          return;
        }
        const installed = loadInstalledSkills();
        const lines = skillNames.map((name) => {
          const info = installed.get(name);
          const cmd = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
          const desc = info?.description ? ` — ${info.description.slice(0, 80)}` : "";
          return `/${cmd}  <b>${info?.label ?? name}</b>${desc}`;
        });
        await ctx.reply(
          `<b>可用技能（${skillNames.length}）：</b>\n\n${lines.join("\n\n")}\n\n` +
          `💡 直接发送 <code>/技能名 你的需求</code> 即可调用`,
          { parse_mode: "HTML" },
        );
        return;
      }

      // Skill command detection: /skillname [args]
      const skillContext = this.resolveSkillCommand(cmdText);

      // Append file paths with explicit read instruction
      let fullText = skillContext?.userText ?? extracted.text;
      if (extracted.filePaths?.length) {
        const pathsNote = extracted.filePaths.map((p: string) => `文件路径: ${p}`).join("\n");
        fullText = `${fullText}\n\n${pathsNote}\n⚠️ 这是一个新文件，请直接读取上述路径的文件内容，不要参考任何历史对话中出现过的文件内容。`;
      }

      console.log(`[Telegram] Message from ${msg.from?.username ?? msg.from?.id}: ${fullText.slice(0, 100)}`);

      const userMsgId = msg.message_id;

      // Ack reaction + typing indicator
      await this.setReaction(chatId, userMsgId, "👀");
      await ctx.replyWithChatAction("typing").catch(() => {});

      // Generate and deliver reply
      const hasFiles = (extracted.filePaths?.length ?? 0) > 0;
      let ok = false;
      try {
        await this.generateAndDeliver(ctx, fullText, chatId, skillContext?.skillContent, hasFiles);
        ok = true;
      } finally {
        await this.setReaction(chatId, userMsgId, ok ? "👍" : "😢");
      }
    } finally {
      this.inflight.delete(dedupKey);
    }
  }

  // ── Content extraction ──────────────────────────────────────────────────────

  private async extractContent(ctx: Context): Promise<{ text: string; filePaths?: string[] }> {
    const msg = ctx.message;
    if (!msg) return { text: "" };

    // Text message
    if (msg.text) {
      let text = msg.text;
      // Strip @bot mention
      if (this.botUsername) {
        text = text.replace(new RegExp(`@${this.botUsername}\\s*`, "gi"), "").trim();
      }
      return { text: text || "[空消息]" };
    }

    // Photo
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      const tmpPath = this.bot ? await downloadTelegramFile(this.bot, photo.file_id, this.effectiveProxyUrl) : null;
      const caption = msg.caption ?? "";
      if (tmpPath) {
        return { text: caption || "用户发来了一张图片", filePaths: [tmpPath] };
      }
      return { text: caption || "[图片消息]" };
    }

    // Voice / Audio
    if (msg.voice || msg.audio) {
      const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
      if (fileId && this.bot) {
        const tmpPath = await downloadTelegramFile(this.bot, fileId, this.effectiveProxyUrl);
        if (tmpPath) {
          return { text: "用户发来了一条语音消息", filePaths: [tmpPath] };
        }
      }
      return { text: "[语音消息]" };
    }

    // Document
    if (msg.document) {
      const fileName = msg.document.file_name ?? "未知文件";
      if (this.bot) {
        const tmpPath = await downloadTelegramFile(this.bot, msg.document.file_id, this.effectiveProxyUrl, fileName);
        if (tmpPath) {
          const caption = msg.caption ? `${msg.caption}\n\n` : "";
          return { text: `${caption}用户发来了一个文件：${fileName}`, filePaths: [tmpPath] };
        }
      }
      return { text: `[文件: ${fileName}]` };
    }

    // Video
    if (msg.video) {
      if (this.bot) {
        const tmpPath = await downloadTelegramFile(this.bot, msg.video.file_id, this.effectiveProxyUrl);
        if (tmpPath) {
          return { text: msg.caption || "用户发来了一段视频", filePaths: [tmpPath] };
        }
      }
      return { text: "[视频消息]" };
    }

    // Sticker
    if (msg.sticker) {
      return { text: `[表情: ${msg.sticker.emoji ?? "🤔"}]` };
    }

    // Location
    if (msg.location) {
      return { text: `[位置: ${msg.location.latitude}, ${msg.location.longitude}]` };
    }

    // Caption fallback (for media with captions)
    if (msg.caption) {
      return { text: msg.caption };
    }

    return { text: "" };
  }

  // ── Skill command resolution ────────────────────────────────────────────────

  private resolveSkillCommand(text: string): { skillContent: string; userText: string } | null {
    if (!text.startsWith("/")) return null;
    const skillNames = this.opts.skillNames ?? [];
    if (skillNames.length === 0) return null;

    const match = text.match(/^\/(\S+)(?:\s+(.*))?$/s);
    if (!match) return null;
    const [, cmd, args] = match;

    const normalizedCmd = cmd.toLowerCase().replace(/@\S+$/, "");
    const matched = skillNames.find(
      (name) => name.toLowerCase().replace(/[^a-z0-9_]/g, "_") === normalizedCmd || name.toLowerCase() === normalizedCmd,
    );
    if (!matched) return null;

    const content = loadSkillContent(matched);
    if (!content) {
      console.warn(`[Telegram] Skill "${matched}" SKILL.md not found`);
      return null;
    }

    const userText = args?.trim() || `请执行技能 ${matched}`;
    console.log(`[Telegram] Skill command: /${normalizedCmd} → ${matched} (${content.length} chars)`);
    return { skillContent: content, userText };
  }

  // ── Generate reply and deliver ──────────────────────────────────────────────

  private async generateAndDeliver(
    ctx: Context,
    userText: string,
    chatId: string,
    skillContent?: string,
    hasFiles?: boolean,
  ): Promise<void> {
    const historyKey = `${this.opts.assistantId}:${chatId}`;
    const history = getHistory(historyKey);
    const provider = this.opts.provider ?? "claude";

    const sessionId = getBotSession(
      this.opts.assistantId,
      chatId,
      this.opts.assistantName,
      provider,
      this.opts.model,
      this.opts.defaultCwd,
    );

    sessionStore?.recordMessage(sessionId, { type: "user_prompt", prompt: userText });

    history.push({ role: "user", content: userText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = buildSmartMemoryContext(userText, this.opts.assistantId, this.opts.defaultCwd);

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nowStr = new Date().toLocaleString("zh-CN", { timeZone: tz, hour12: false });
    const currentTimeContext = `## 当前时间\n消息发送时间：${nowStr}（时区：${tz}）`;

    const skillSection = skillContent
      ? `## 当前激活技能\n请严格按照以下技能说明执行用户请求：\n\n${skillContent}`
      : undefined;

    // When starting a fresh session for file messages, inject recent history so
    // Claude knows what was discussed before, even without a resumed session.
    const historySection = (hasFiles && history.length > 1)
      ? buildHistoryContext(history.slice(0, -1), this.opts.assistantId)
      : undefined;

    const system = buildStructuredPersona(this.opts, currentTimeContext, memoryContext, skillSection, historySection);

    // Set thinking reaction
    await this.setReaction(chatId, ctx.message!.message_id, "🤔");

    let result: StreamResult;

    try {
      if (provider === "codex") {
        result = await this.runCodexSession(system, history, userText, ctx);
      } else {
        result = await this.runClaudeQuery(system, userText, ctx, chatId, hasFiles);
      }
    } catch (err) {
      console.error("[Telegram] AI error:", err);
      result = { text: "抱歉，处理您的消息时遇到了问题，请稍后再试。", draftMessageId: null };
    }

    const replyText = result.text;
    history.push({ role: "assistant", content: replyText });
    this.persistReply(sessionId, replyText, userText);
    updateBotSessionTitle(sessionId, history, "[Telegram]").catch(() => {});

    // Finalize: deliver the response
    await this.finalizeResponse(ctx, chatId, replyText, result.draftMessageId);
  }

  /** Edit the draft or send chunked final response */
  private async finalizeResponse(
    ctx: Context,
    chatId: string,
    replyText: string,
    draftMessageId: number | null,
  ): Promise<void> {
    const chunks = chunkMessage(replyText);
    const chatIdNum = Number(chatId);

    if (draftMessageId && chunks.length === 1) {
      // Single chunk — edit the streaming draft to its final version
      const html = markdownToTelegramHtml(chunks[0]);
      try {
        await this.bot!.api.editMessageText(chatIdNum, draftMessageId, html, { parse_mode: "HTML" });
        return;
      } catch {
        try {
          await this.bot!.api.editMessageText(chatIdNum, draftMessageId, chunks[0]);
          return;
        } catch { /* fall through to chunked send */ }
      }
    }

    // Delete the streaming draft — we'll send properly chunked messages
    if (draftMessageId) {
      await this.bot?.api.deleteMessage(chatIdNum, draftMessageId).catch(() => {});
    }

    for (const chunk of chunks) {
      try {
        await ctx.reply(markdownToTelegramHtml(chunk), {
          parse_mode: "HTML",
          reply_to_message_id: ctx.message?.message_id,
        });
      } catch {
        try {
          await ctx.reply(chunk, { reply_to_message_id: ctx.message?.message_id });
        } catch (err2) {
          console.error("[Telegram] Reply failed:", err2);
        }
      }
    }
  }

  /** Send a new streaming draft or edit the existing one */
  private async upsertDraft(
    ctx: Context,
    text: string,
    draftMessageId: number | null,
  ): Promise<number | null> {
    const preview = text.length > TG_MESSAGE_LIMIT - 20
      ? text.slice(0, TG_MESSAGE_LIMIT - 20) + DRAFT_SUFFIX
      : text + DRAFT_SUFFIX;

    if (!draftMessageId) {
      try {
        const sent = await ctx.reply(markdownToTelegramHtml(preview), {
          parse_mode: "HTML",
          reply_to_message_id: ctx.message?.message_id,
        });
        return sent.message_id;
      } catch {
        try {
          const sent = await ctx.reply(preview, { reply_to_message_id: ctx.message?.message_id });
          return sent.message_id;
        } catch { return null; }
      }
    }

    // Edit existing draft
    const chatId = Number(ctx.chat!.id);
    try {
      await this.bot!.api.editMessageText(chatId, draftMessageId, markdownToTelegramHtml(preview), {
        parse_mode: "HTML",
      });
    } catch {
      try {
        await this.bot!.api.editMessageText(chatId, draftMessageId, preview);
      } catch { /* MESSAGE_NOT_MODIFIED or other — ignore */ }
    }
    return draftMessageId;
  }

  /** Claude query() path via Agent SDK with shared MCP + per-session MCP + streaming preview */
  private async runClaudeQuery(
    system: string,
    userText: string,
    ctx: Context,
    chatId: string,
    hasFiles?: boolean,
  ): Promise<StreamResult> {
    const sessionKey = `${this.opts.assistantId}:${chatId}`;
    const sessionMcp = this.createSessionMcp(ctx);
    const sharedMcp = createSharedMcpServer({ assistantId: this.opts.assistantId, sessionCwd: this.opts.defaultCwd });
    // File messages must not resume previous session — the old session context
    // may contain content from a previously read file, causing Claude to mix up files.
    const claudeSessionId = hasFiles ? undefined : getBotClaudeSessionId(sessionKey);
    const claudeCodePath = getClaudeCodePath();

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    let finalText = "";
    let accumulatedText = "";
    let draftMessageId: number | null = null;
    let lastEditTime = 0;

    try {
      const q = query({
        prompt: userText,
        options: {
          systemPrompt: system,
          resume: claudeSessionId,
          cwd: this.opts.defaultCwd ?? homedir(),
          mcpServers: { "vk-shared": sharedMcp, "tg-session": sessionMcp },
          permissionMode: "bypassPermissions",
          includePartialMessages: true,
          allowDangerouslySkipPermissions: true,
          maxTurns: 300,
          settingSources: getSettingSources(),
          pathToClaudeCodeExecutable: claudeCodePath,
          env: buildQueryEnv(),
        },
      });

      for await (const message of q) {
        const msg = message as Record<string, unknown>;
        if (msg.type === "result" && msg.subtype === "success") {
          finalText = msg.result as string;
          setBotClaudeSessionId(sessionKey, msg.session_id as string);
          continue;
        }

        const partial = extractPartialText(msg);
        if (partial && partial.length > accumulatedText.length) {
          accumulatedText = partial;
          const now = Date.now();
          if (now - lastEditTime >= DRAFT_THROTTLE_MS) {
            draftMessageId = await this.upsertDraft(ctx, accumulatedText, draftMessageId);
            lastEditTime = now;
          }
        }
      }
    } finally {
      clearInterval(typingInterval);
    }

    return {
      text: finalText || accumulatedText || "抱歉，无法生成回复。",
      draftMessageId,
    };
  }

  /** Per-session MCP server with send_message + send_file tools */
  private createSessionMcp(ctx: Context) {
    const self = this;

    const sendMessageTool = tool(
      "send_message",
      "向当前 Telegram 对话立即发送一条消息。适合在执行长任务时告知用户进度。",
      { text: z.string().describe("要发送的消息内容（支持 Markdown）") },
      async (input) => {
        const text = String(input.text ?? "").trim();
        if (!text) return { content: [{ type: "text" as const, text: "消息内容为空" }] };
        const chunks = chunkMessage(text);
        for (const chunk of chunks) {
          await ctx.reply(markdownToTelegramHtml(chunk), { parse_mode: "HTML" }).catch(() => {
            ctx.reply(chunk).catch(() => {});
          });
        }
        return { content: [{ type: "text" as const, text: "消息已发送" }] };
      },
    );

    const sendFileTool = tool(
      "send_file",
      "通过 Telegram 将本地文件发送给当前对话的用户。支持图片、PDF、文档等。",
      { file_path: z.string().describe("要发送的文件的完整本地路径") },
      async (input) => {
        const result = await self.doSendFile(String(input.file_path ?? ""), ctx);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    return createSdkMcpServer({ name: "telegram-session", tools: [sendMessageTool, sendFileTool] });
  }

  /** Codex provider session with streaming preview + typing indicator */
  private async runCodexSession(
    system: string,
    history: ConvMessage[],
    userText: string,
    ctx: Context,
  ): Promise<StreamResult> {
    const codexOpts: CodexOptions = {};
    const codexPath = getCodexBinaryPath();
    if (codexPath) codexOpts.codexPathOverride = codexPath;

    const codex = new Codex(codexOpts);
    const threadOpts: ThreadOptions = {
      model: this.opts.model || "gpt-5.3-codex",
      workingDirectory: this.opts.defaultCwd || homedir(),
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    };

    const historyLines = history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    const fullPrompt = `${system}\n\n${historyLines}\n\nPlease reply to the latest user message above.`;

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    let draftMessageId: number | null = null;
    let lastEditTime = 0;

    try {
      const thread = codex.startThread(threadOpts);
      const { events } = await thread.runStreamed(fullPrompt, {});

      const textParts: string[] = [];
      for await (const event of events) {
        if (
          event.type === "item.completed" &&
          event.item.type === "agent_message" &&
          event.item.text
        ) {
          textParts.push(event.item.text);
          const accumulated = textParts.join("").trim();
          const now = Date.now();
          if (now - lastEditTime >= DRAFT_THROTTLE_MS) {
            draftMessageId = await this.upsertDraft(ctx, accumulated, draftMessageId);
            lastEditTime = now;
          }
        }
      }

      const text = textParts.join("").trim() || "抱歉，无法生成回复。";
      return { text, draftMessageId };
    } finally {
      clearInterval(typingInterval);
    }
  }

  /** Send a file to the current chat */
  private async doSendFile(filePath: string, ctx: Context): Promise<string> {
    const fs = await import("fs");
    const path = await import("path");

    if (!filePath || !fs.existsSync(filePath)) return `文件不存在: ${filePath}`;

    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const isImage = ["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext);
    const fileName = path.basename(filePath);

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const inputFile = new (await import("grammy")).InputFile(fileBuffer, fileName);

      if (isImage) {
        await ctx.replyWithPhoto(inputFile);
      } else {
        await ctx.replyWithDocument(inputFile);
      }
      return `文件已发送: ${fileName}`;
    } catch (err) {
      return `发送失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Persist reply ────────────────────────────────────────────────────────────

  private persistReply(sessionId: string, replyText: string, userText?: string): void {
    sessionStore?.recordMessage(sessionId, {
      type: "assistant",
      uuid: randomUUID(),
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: replyText }],
        model: this.opts.model || "",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } as unknown as import("../types.js").StreamMessage);

    if (userText) {
      recordConversation(
        `\n## ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${userText}\n**${this.opts.assistantName}**: ${replyText}\n`,
        { assistantId: this.opts.assistantId, assistantName: this.opts.assistantName, channel: "Telegram" },
      );
    }
  }
}
