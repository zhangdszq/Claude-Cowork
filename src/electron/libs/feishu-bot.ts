/**
 * Feishu (Lark) WebSocket Bot Service
 *
 * Mirrors the DingTalk Stream bot implementation:
 * - Feishu SDK @larksuiteoapi/node-sdk WSClient for long-connection
 * - Extensible tool registry (take_screenshot, send_file, bash, send_message, web_fetch, web_search, read_file, write_file)
 * - AI provider selection: Anthropic Claude or OpenAI Codex
 * - Session/memory sync with the in-app session store
 * - Conversation history (last N turns)
 * - Dynamic session title generation
 * - Message deduplication
 */
import * as lark from "@larksuiteoapi/node-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { loadUserSettings } from "./user-settings.js";
import { getCodexBinaryPath } from "./codex-runner.js";
import { buildSmartMemoryContext, appendDailyMemory } from "./memory-store.js";
import type { SessionStore } from "./session-store.js";

// ─── Tool Registry (mirrors DingTalk) ─────────────────────────────────────────

interface ToolContext {
  senderId: string;
  chatId: string;
  messageId: string;
  sendProgress: (text: string) => Promise<void>;
}

interface ToolEntry {
  schema: Anthropic.Tool;
  hint: string;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

class ToolRegistry {
  private entries = new Map<string, ToolEntry>();

  register(entry: ToolEntry): this {
    this.entries.set(entry.schema.name, entry);
    return this;
  }

  get schemas(): Anthropic.Tool[] {
    return [...this.entries.values()].map((e) => e.schema);
  }

  get toolHint(): string {
    if (this.entries.size === 0) return "";
    return [
      "## 可用工具",
      "你可以调用以下工具完成用户请求，无需询问，直接执行：",
      ...[...this.entries.values()].map((e) => `- **${e.schema.name}** — ${e.hint}`),
      "",
      "工具调用流程示例：截图 → take_screenshot → 得到路径 → send_file 发送",
    ].join("\n");
  }

  async run(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string> {
    const entry = this.entries.get(name);
    if (!entry) return `未知工具: ${name}`;
    return entry.execute(input, ctx);
  }
}

// ─── Web utilities ─────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function webFetch(url: string, maxChars = 8_000): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const contentType = resp.headers.get("content-type") ?? "";
  const text = await resp.text();
  return contentType.includes("text/html") ? stripHtml(text).slice(0, maxChars) : text.slice(0, maxChars);
}

async function webSearch(query: string, maxResults = 5): Promise<string> {
  try {
    const iaUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(iaUrl, {
      headers: { "User-Agent": "VK-Cowork-Bot/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        Answer?: string;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      const parts: string[] = [];
      if (data.Answer) parts.push(`**答案**: ${data.Answer}`);
      if (data.AbstractText) {
        parts.push(`**摘要**: ${data.AbstractText}`);
        if (data.AbstractURL) parts.push(`来源: ${data.AbstractURL}`);
      }
      const results = data.Results?.slice(0, maxResults) ?? [];
      if (results.length > 0) {
        parts.push("\n**搜索结果**:");
        for (const r of results) {
          if (r.Text && r.FirstURL) parts.push(`- ${r.Text.slice(0, 200)}\n  ${r.FirstURL}`);
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
  } catch {
    // fall through
  }

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(searchUrl, {
    headers: { "User-Agent": "Mozilla/5.0 AppleWebKit/537.36" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Search failed: HTTP ${resp.status}`);
  const html = await resp.text();
  const titleRe = /<a class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const urlRe = /uddg=([^&"]+)/g;
  const titles: string[] = [];
  const snippets: string[] = [];
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) titles.push(stripHtml(m[1]).slice(0, 120));
  while ((m = snippetRe.exec(html)) !== null) snippets.push(stripHtml(m[1]).slice(0, 250));
  while ((m = urlRe.exec(html)) !== null) {
    try { urls.push(decodeURIComponent(m[1])); } catch { urls.push(m[1]); }
  }
  const count = Math.min(maxResults, titles.length);
  if (count === 0) return `未找到"${query}"相关结果。`;
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    results.push(`**${i + 1}. ${titles[i]}**${snippets[i] ? `\n${snippets[i]}` : ""}${urls[i] ? `\n${urls[i]}` : ""}`);
  }
  return `搜索"${query}"结果：\n\n${results.join("\n\n")}`;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export type FeishuBotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface FeishuBotOptions {
  appId: string;
  appSecret: string;
  /** "feishu" (default) or "lark" */
  domain?: "feishu" | "lark";
  assistantId: string;
  assistantName: string;
  persona?: string;
  provider?: "claude" | "codex";
  model?: string;
  defaultCwd?: string;
  /** Max reconnect attempts (default: 10) */
  maxConnectionAttempts?: number;
}

interface ConvMessage {
  role: "user" | "assistant";
  content: string;
}

// ─── Message deduplication ─────────────────────────────────────────────────────

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

// ─── Status emitter ────────────────────────────────────────────────────────────

const statusEmitter = new EventEmitter();

export function onFeishuBotStatusChange(
  cb: (assistantId: string, status: FeishuBotStatus, detail?: string) => void,
): () => void {
  statusEmitter.on("status", cb);
  return () => statusEmitter.off("status", cb);
}

function emit(assistantId: string, status: FeishuBotStatus, detail?: string) {
  statusEmitter.emit("status", assistantId, status, detail);
}

// ─── Injected session store ────────────────────────────────────────────────────

let sessionStore: SessionStore | null = null;

export function setFeishuSessionStore(store: SessionStore): void {
  sessionStore = store;
}

// ─── Connection pool ───────────────────────────────────────────────────────────

const pool = new Map<string, FeishuConnection>();

export async function startFeishuBot(opts: FeishuBotOptions): Promise<void> {
  stopFeishuBot(opts.assistantId);
  const conn = new FeishuConnection(opts);
  pool.set(opts.assistantId, conn);
  await conn.start();
}

export function stopFeishuBot(assistantId: string): void {
  const conn = pool.get(assistantId);
  if (conn) {
    conn.stop();
    pool.delete(assistantId);
  }
  emit(assistantId, "disconnected");
}

export function getFeishuBotStatus(assistantId: string): FeishuBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

// ─── Conversation history & session management ─────────────────────────────────

const histories = new Map<string, ConvMessage[]>();
const MAX_TURNS = 10;
const botSessionIds = new Map<string, string>();
const titledSessions = new Set<string>();

function getHistory(assistantId: string): ConvMessage[] {
  if (!histories.has(assistantId)) histories.set(assistantId, []);
  return histories.get(assistantId)!;
}

function getBotSession(
  assistantId: string,
  assistantName: string,
  provider: "claude" | "codex",
  model: string | undefined,
  cwd: string | undefined,
): string {
  if (botSessionIds.has(assistantId)) return botSessionIds.get(assistantId)!;
  if (!sessionStore) throw new Error("[Feishu] SessionStore not injected");
  const session = sessionStore.createSession({
    title: `[飞书] ${assistantName}`,
    assistantId,
    provider,
    model,
    cwd,
  });
  botSessionIds.set(assistantId, session.id);
  return session.id;
}

async function updateBotSessionTitle(sessionId: string, firstMessage: string): Promise<void> {
  if (titledSessions.has(sessionId)) return;
  titledSessions.add(sessionId);
  const fallback = firstMessage.slice(0, 40).trim() + (firstMessage.length > 40 ? "…" : "");
  let title = fallback;
  try {
    const { generateSessionTitle } = await import("../api/services/runner.js");
    const generated = await generateSessionTitle(
      `请根据以下对话内容，生成一个简短的中文标题（10字以内，不加引号），直接输出标题：\n${firstMessage}`,
    );
    if (generated && generated !== "New Session") title = generated;
  } catch {
    // keep fallback
  }
  sessionStore?.updateSession(sessionId, { title: `[飞书] ${title}` });
}

// ─── Anthropic client cache ────────────────────────────────────────────────────

const anthropicClients = new Map<string, { client: Anthropic; apiKey: string; baseURL: string }>();

function getAnthropicClient(assistantId: string): Anthropic {
  const settings = loadUserSettings();
  const apiKey =
    settings.anthropicAuthToken ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    "";
  const baseURL = settings.anthropicBaseUrl || "";
  const cached = anthropicClients.get(assistantId);
  if (cached && cached.apiKey === apiKey && cached.baseURL === baseURL) return cached.client;
  if (!apiKey) throw new Error("未配置 Anthropic API Key，请在设置中填写。");
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined });
  anthropicClients.set(assistantId, { client, apiKey, baseURL });
  return client;
}

// ─── FeishuConnection ──────────────────────────────────────────────────────────

class FeishuConnection {
  status: FeishuBotStatus = "disconnected";
  private wsClient: InstanceType<typeof lark.WSClient> | null = null;
  private feishuClient: InstanceType<typeof lark.Client>;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = new Set<string>();
  private tools!: ToolRegistry;

  constructor(private opts: FeishuBotOptions) {
    const domain = opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.feishuClient = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain,
    });
    this.tools = this.initTools();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.status = "connecting";
    emit(this.opts.assistantId, "connecting");

    try {
      await this.connect();
    } catch (err) {
      this.stopped = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      pool.delete(this.opts.assistantId);
      throw err;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.wsClient?.close();
    } catch { /* ignore */ }
    this.wsClient = null;
    this.status = "disconnected";
  }

  private async connect(): Promise<void> {
    const domain = this.opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

    const dispatcher = new lark.EventDispatcher({
      encryptKey: "",
    }).register({
      "im.message.receive_v1": async (data: Record<string, unknown>) => {
        try {
          await this.handleMessage(data);
        } catch (err) {
          console.error("[Feishu] Message handling error:", err);
        }
      },
    });

    const wsClient = new lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.warn,
    });
    this.wsClient = wsClient;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      // The Feishu SDK WSClient.start() doesn't return a promise indicating
      // connection success, so we use a timeout to detect initial failures.
      const connectTimeout = setTimeout(() => {
        if (this.status === "connecting") {
          // Still connecting after 10s — assume success (SDK is polling)
          this.status = "connected";
          emit(this.opts.assistantId, "connected");
          this.reconnectAttempts = 0;
          console.log(`[Feishu] Connected: assistant=${this.opts.assistantId}`);
          settle();
        }
      }, 10_000);

      wsClient.start({ eventDispatcher: dispatcher }).then(() => {
        clearTimeout(connectTimeout);
        if (!this.stopped) {
          this.status = "connected";
          emit(this.opts.assistantId, "connected");
          this.reconnectAttempts = 0;
          console.log(`[Feishu] Connected: assistant=${this.opts.assistantId}`);
          settle();
        }
      }).catch((err: Error) => {
        clearTimeout(connectTimeout);
        console.error("[Feishu] WSClient.start() failed:", err.message);
        this.status = "error";
        emit(this.opts.assistantId, "error", err.message);
        if (!this.stopped) {
          settle(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const maxAttempts = this.opts.maxConnectionAttempts ?? 10;
    if (this.reconnectAttempts >= maxAttempts) {
      this.status = "error";
      emit(this.opts.assistantId, "error", `已达最大重连次数 (${maxAttempts})，请手动重新连接`);
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
    this.reconnectAttempts++;
    console.log(`[Feishu] Reconnect attempt ${this.reconnectAttempts}/${maxAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error("[Feishu] Reconnect failed:", err.message);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  // ── Message handling ──────────────────────────────────────────────────────────

  private async handleMessage(data: Record<string, unknown>): Promise<void> {
    const message = data.message as Record<string, unknown> | undefined;
    const sender = data.sender as Record<string, unknown> | undefined;
    if (!message || !sender) return;

    const messageId = String(message.message_id ?? "");
    const msgType = String(message.message_type ?? "text");
    const chatId = String(message.chat_id ?? "");
    const senderId = String((sender.sender_id as Record<string, unknown>)?.open_id ?? "");

    // Skip bot's own messages
    const senderType = String(sender.sender_type ?? "");
    if (senderType === "app") return;

    // Deduplication
    const dedupKey = messageId ? `feishu:${this.opts.assistantId}:${messageId}` : null;
    if (dedupKey) {
      if (isDuplicate(dedupKey) || this.inflight.has(dedupKey)) {
        console.log(`[Feishu][${this.opts.assistantName}] Dup/in-flight skip: ${messageId}`);
        return;
      }
      markProcessed(dedupKey);
      this.inflight.add(dedupKey);
    }

    try {
      const extracted = this.extractText(message, msgType);
      if (!extracted) return;

      console.log(`[Feishu] Message (${msgType}): ${extracted.slice(0, 100)}`);

      await this.generateAndDeliver(extracted, senderId, chatId, messageId);
    } finally {
      if (dedupKey) this.inflight.delete(dedupKey);
    }
  }

  private extractText(message: Record<string, unknown>, msgType: string): string | null {
    try {
      const contentRaw = String(message.content ?? "{}");
      const content = JSON.parse(contentRaw) as Record<string, unknown>;

      if (msgType === "text") {
        const text = String(content.text ?? "").trim();
        // Strip @bot mention in group chats
        return text.replace(/@[^\s]+\s*/g, "").trim() || null;
      }

      if (msgType === "post") {
        // Rich text - extract all text nodes
        const parts: string[] = [];
        const content2 = content as { content?: Array<Array<{ tag?: string; text?: string }>> };
        for (const line of content2.content ?? []) {
          for (const node of line) {
            if (node.tag === "text" && node.text) parts.push(node.text);
          }
        }
        return parts.join("").trim() || "[富文本消息]";
      }

      if (msgType === "image") return "[图片消息]";
      if (msgType === "audio") return "[语音消息]";
      if (msgType === "file") return `[文件: ${String(content.file_name ?? "未知")}]`;
      if (msgType === "video") return "[视频消息]";
      if (msgType === "sticker") return "[表情包]";

      return `[${msgType} 消息]`;
    } catch {
      return null;
    }
  }

  // ── Generate reply and deliver ─────────────────────────────────────────────────

  private async generateAndDeliver(
    userText: string,
    senderId: string,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    const history = getHistory(this.opts.assistantId);
    const provider = this.opts.provider ?? "claude";

    const sessionId = getBotSession(
      this.opts.assistantId,
      this.opts.assistantName,
      provider,
      this.opts.model,
      this.opts.defaultCwd,
    );

    sessionStore?.recordMessage(sessionId, { type: "user_prompt", prompt: userText });
    updateBotSessionTitle(sessionId, userText).catch(() => {});

    history.push({ role: "user", content: userText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = buildSmartMemoryContext(userText);
    const basePersona =
      this.opts.persona?.trim() ||
      `你是 ${this.opts.assistantName}，一个智能助手，请简洁有用地回答问题。`;

    const outputRules = `## 回复规范（必须遵守）
- 直接给出结果，不要叙述你的思考过程或执行步骤
- 调用工具时保持沉默，只在工具全部完成后给出一句话结论
- 截图/发文件类任务：工具执行完只需回复"已发送"或简短说明，不要写"我先截图再上传再发送…"
- 禁止把工具调用的中间状态、路径、API 返回值等细节写进最终回复
- 如果任务失败，简短说明原因即可，无需描述每个步骤`;

    const system = [basePersona, outputRules, memoryContext, this.tools.toolHint]
      .filter(Boolean)
      .join("\n\n");

    const ctx: ToolContext = {
      senderId,
      chatId,
      messageId,
      sendProgress: (text: string) => this.sendReply(messageId, chatId, text).catch(() => {}),
    };

    let replyText: string;

    try {
      if (provider === "codex") {
        replyText = await this.runCodex(system, history, userText);
      } else {
        replyText = await this.runClaude(system, history, userText, ctx);
      }
    } catch (err) {
      console.error("[Feishu] AI error:", err);
      replyText = "抱歉，处理您的消息时遇到了问题，请稍后再试。";
    }

    history.push({ role: "assistant", content: replyText });
    this.persistReply(sessionId, replyText, userText);

    await this.sendReply(messageId, chatId, replyText);
  }

  // ── Claude ────────────────────────────────────────────────────────────────────

  private async runClaude(
    system: string,
    history: ConvMessage[],
    userText: string,
    ctx: ToolContext,
  ): Promise<string> {
    const client = getAnthropicClient(this.opts.assistantId);
    const model = this.opts.model || "claude-opus-4-5";

    const messages: Anthropic.MessageParam[] = history.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    messages.push({ role: "user", content: userText });

    const toolSchemas = this.tools.schemas;
    const MAX_TOOL_TURNS = 8;
    let toolTurns = 0;

    while (toolTurns < MAX_TOOL_TURNS) {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUseBlocks.length === 0 || response.stop_reason !== "tool_use") {
        const textBlock = response.content.find(
          (b): b is Anthropic.TextBlock => b.type === "text",
        );
        return textBlock?.text ?? "抱歉，无法生成回复。";
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tb of toolUseBlocks) {
        const inputPreview = JSON.stringify(tb.input).slice(0, 120);
        console.log(`[Feishu][tool] ${tb.name}(${inputPreview})`);
        let result: string;
        try {
          result = await this.tools.run(tb.name, tb.input as Record<string, unknown>, ctx);
        } catch (err) {
          result = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
        }
        console.log(`[Feishu][tool] ${tb.name} → ${result.slice(0, 150)}`);
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: result });
      }

      messages.push({ role: "user", content: toolResults });
      toolTurns++;
    }

    return "抱歉，工具调用次数超过上限，请换个方式提问。";
  }

  // ── Codex ─────────────────────────────────────────────────────────────────────

  private async runCodex(
    system: string,
    history: ConvMessage[],
    userText: string,
  ): Promise<string> {
    const codexOpts: CodexOptions = {};
    const codexPath = getCodexBinaryPath();
    if (codexPath) codexOpts.codexPathOverride = codexPath;

    const codex = new Codex(codexOpts);
    const threadOpts: ThreadOptions = {
      model: this.opts.model || "gpt-5.3-codex",
      workingDirectory: this.opts.defaultCwd || process.cwd(),
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    };

    const historyLines = history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    const fullPrompt = `${system}\n\n${historyLines}\n\nPlease reply to the latest user message above.`;

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
      }
    }
    return textParts.join("").trim() || "抱歉，无法生成回复。";
  }

  // ── Persist reply ─────────────────────────────────────────────────────────────

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
      appendDailyMemory(
        `\n## [飞书] ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${userText}\n**${this.opts.assistantName}**: ${replyText}\n`,
      );
    }
  }

  // ── Send message ──────────────────────────────────────────────────────────────

  private async sendReply(messageId: string, chatId: string, text: string): Promise<void> {
    try {
      // Reply in thread if we have a messageId
      if (messageId) {
        await this.feishuClient.im.message.reply({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify({ text }),
            msg_type: "text",
            reply_in_thread: false,
          },
        });
        return;
      }

      // Fallback: send to chat
      if (chatId) {
        await this.feishuClient.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text }),
            msg_type: "text",
          },
        });
      }
    } catch (err) {
      console.error("[Feishu] Send reply error:", err);
    }
  }

  // ── Tool registry factory ─────────────────────────────────────────────────────

  private initTools(): ToolRegistry {
    const registry = new ToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // ── take_screenshot ─────────────────────────────────────────────────────
    registry.register({
      hint: "截取当前桌面截图，返回临时文件路径（之后用 send_file 发送）",
      schema: {
        name: "take_screenshot",
        description: "截取当前桌面屏幕截图。返回截图的临时文件路径，之后可用 send_file 发送给用户。",
        input_schema: { type: "object" as const, properties: {}, required: [] },
      },
      async execute(_input, ctx) {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        const os = await import("os");
        const path = await import("path");
        const fs = await import("fs");

        const filePath = path.join(os.tmpdir(), `vk-shot-${Date.now()}.png`);
        await ctx.sendProgress("📸 正在截图…");

        const platform = process.platform;
        if (platform === "darwin") {
          await execAsync(`screencapture -x "${filePath}"`);
        } else if (platform === "win32") {
          await execAsync(
            `powershell -command "Add-Type -AssemblyName System.Windows.Forms; ` +
            `$b=New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); ` +
            `$g=[System.Drawing.Graphics]::FromImage($b); ` +
            `$g.CopyFromScreen(0,0,0,0,$b.Size); ` +
            `$b.Save('${filePath}')"`,
          );
        } else {
          await execAsync(`gnome-screenshot -f "${filePath}" 2>/dev/null || scrot "${filePath}"`);
        }
        if (!fs.existsSync(filePath)) throw new Error("截图文件未生成");
        return filePath;
      },
    });

    // ── send_file ────────────────────────────────────────────────────────────
    registry.register({
      hint: "将本机文件通过飞书发送给当前用户（支持图片/文件，自动压缩超大图片）",
      schema: {
        name: "send_file",
        description:
          "通过飞书将本地文件发送给当前对话的用户。支持图片（png/jpg）、PDF、文档等。" +
          "file_path 必须是本机可读取的完整路径。超出大小限制时会自动处理。",
        input_schema: {
          type: "object" as const,
          properties: {
            file_path: { type: "string", description: "要发送的文件的完整本地路径" },
          },
          required: ["file_path"],
        },
      },
      async execute(input, ctx) {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        const path = await import("path");
        const fs = await import("fs");
        const os2 = await import("os");

        const filePath = String(input.file_path ?? "");
        if (!filePath || !fs.existsSync(filePath)) return `文件不存在: ${filePath}`;

        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        const isImage = ["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext);
        const IMAGE_LIMIT = 20 * 1024 * 1024;

        const tempFiles: string[] = [];
        const cleanup = () => {
          for (const f of tempFiles) {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
          }
        };

        let sendPath = filePath;
        const stat = fs.statSync(filePath);

        if (isImage && stat.size > IMAGE_LIMIT) {
          const compressedPath = path.join(os2.tmpdir(), `vk-compressed-${Date.now()}.jpg`);
          tempFiles.push(compressedPath);
          try {
            if (process.platform === "darwin") {
              await execAsync(
                `sips -s format jpeg -s formatOptions 70 -Z 2000 "${filePath}" --out "${compressedPath}"`,
              );
            } else {
              await execAsync(
                `convert "${filePath}" -resize 2000x2000> -quality 70 "${compressedPath}"`,
              );
            }
            const newStat = fs.statSync(compressedPath);
            if (newStat.size <= IMAGE_LIMIT) {
              sendPath = compressedPath;
            } else {
              cleanup();
              return `图片压缩后仍超过 20MB，建议先裁剪或降低分辨率。`;
            }
          } catch {
            cleanup();
            return `图片超过 20MB 限制，压缩失败，请先手动压缩。`;
          }
        }

        try {
          const sendExt = sendPath.split(".").pop()?.toLowerCase() ?? ext;
          const sendIsImage = ["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(sendExt);

          if (sendIsImage) {
            const imageBuffer = fs.readFileSync(sendPath);
            const uploadResp = await self.feishuClient.im.image.create({
              data: {
                image_type: "message",
                image: imageBuffer,
              },
            });
            const imageKey = (uploadResp as Record<string, unknown>)?.image_key as string | undefined;
            if (!imageKey) {
              cleanup();
              return "图片上传失败（无 image_key）";
            }

            // Send via reply
            if (ctx.messageId) {
              await self.feishuClient.im.message.reply({
                path: { message_id: ctx.messageId },
                data: {
                  content: JSON.stringify({ image_key: imageKey }),
                  msg_type: "image",
                  reply_in_thread: false,
                },
              });
            } else if (ctx.chatId) {
              await self.feishuClient.im.message.create({
                params: { receive_id_type: "chat_id" },
                data: {
                  receive_id: ctx.chatId,
                  content: JSON.stringify({ image_key: imageKey }),
                  msg_type: "image",
                },
              });
            }
            cleanup();
            return `图片已发送: ${path.basename(sendPath)}`;
          } else {
            // Upload file
            const fileBuffer = fs.readFileSync(sendPath);
            const fileName = path.basename(sendPath);
            const uploadResp = await self.feishuClient.im.file.create({
              data: {
                file_type: "stream",
                file_name: fileName,
                file: fileBuffer,
              },
            });
            const fileKey = (uploadResp as Record<string, unknown>)?.file_key as string | undefined;
            if (!fileKey) {
              cleanup();
              return "文件上传失败（无 file_key）";
            }

            if (ctx.messageId) {
              await self.feishuClient.im.message.reply({
                path: { message_id: ctx.messageId },
                data: {
                  content: JSON.stringify({ file_key: fileKey }),
                  msg_type: "file",
                  reply_in_thread: false,
                },
              });
            } else if (ctx.chatId) {
              await self.feishuClient.im.message.create({
                params: { receive_id_type: "chat_id" },
                data: {
                  receive_id: ctx.chatId,
                  content: JSON.stringify({ file_key: fileKey }),
                  msg_type: "file",
                },
              });
            }
            cleanup();
            return `文件已发送: ${fileName}`;
          }
        } catch (err) {
          cleanup();
          return `发送失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    // ── bash ─────────────────────────────────────────────────────────────────
    registry.register({
      hint: "在本机执行 shell 命令（查找文件、读取内容等，超时 15s）",
      schema: {
        name: "bash",
        description:
          "在本机执行 bash 命令（macOS/Linux）或 PowerShell（Windows）。" +
          "适合：查找文件（find、ls）、读取文本（cat）、获取系统信息等。超时 15 秒，输出限 3000 字符。",
        input_schema: {
          type: "object" as const,
          properties: { command: { type: "string", description: "要执行的 shell 命令" } },
          required: ["command"],
        },
      },
      async execute(input) {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        const command = String(input.command ?? "").trim();
        if (!command) return "命令为空";
        try {
          const { stdout, stderr } = await execAsync(command, { timeout: 15_000 });
          const out = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
          return out.slice(0, 3000) || "(no output)";
        } catch (err) {
          const e = err as { message?: string; stderr?: string };
          return `命令失败: ${e.message ?? ""}\n${e.stderr ?? ""}`.slice(0, 1000);
        }
      },
    });

    // ── send_message ──────────────────────────────────────────────────────────
    registry.register({
      hint: "向当前对话发送一条进度通知或中间结果消息",
      schema: {
        name: "send_message",
        description:
          "向当前飞书对话立即发送一条文本消息。适合在执行长任务时告知用户进度。",
        input_schema: {
          type: "object" as const,
          properties: {
            text: { type: "string", description: "要发送的消息内容" },
          },
          required: ["text"],
        },
      },
      async execute(input, ctx) {
        const text = String(input.text ?? "").trim();
        if (!text) return "消息内容为空";
        await ctx.sendProgress(text);
        return "消息已发送";
      },
    });

    // ── web_fetch ─────────────────────────────────────────────────────────────
    registry.register({
      hint: "抓取网页 URL 内容，返回可读文本（HTML 自动清除标签）",
      schema: {
        name: "web_fetch",
        description:
          "抓取指定 URL 的内容并以纯文本返回。HTML 页面会自动清除标签，返回可读正文。",
        input_schema: {
          type: "object" as const,
          properties: {
            url: { type: "string", description: "要抓取的 HTTP/HTTPS URL" },
            max_chars: { type: "number", description: "最多返回字符数，默认 8000，最大 20000" },
          },
          required: ["url"],
        },
      },
      async execute(input) {
        const url = String(input.url ?? "").trim();
        if (!url) return "URL 不能为空";
        const maxChars = Math.min(Number(input.max_chars ?? 8_000), 20_000);
        try {
          return await webFetch(url, maxChars);
        } catch (err) {
          return `抓取失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    // ── web_search ────────────────────────────────────────────────────────────
    registry.register({
      hint: "用 DuckDuckGo 搜索网络，返回 top-N 结果摘要和链接",
      schema: {
        name: "web_search",
        description: "通过 DuckDuckGo 搜索网络，返回 top 5 搜索结果。",
        input_schema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "搜索关键词或问题" },
            max_results: { type: "number", description: "最多返回结果数，默认 5，最大 10" },
          },
          required: ["query"],
        },
      },
      async execute(input) {
        const query = String(input.query ?? "").trim();
        if (!query) return "搜索词不能为空";
        const maxResults = Math.min(Number(input.max_results ?? 5), 10);
        try {
          return await webSearch(query, maxResults);
        } catch (err) {
          return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    // ── read_file ─────────────────────────────────────────────────────────────
    registry.register({
      hint: "读取本机文本文件内容（最多 10000 字符）",
      schema: {
        name: "read_file",
        description: "读取本机上的文本文件内容并返回。最多返回 10000 字符。",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string", description: "文件的完整本地路径" },
            max_chars: { type: "number", description: "最多读取字符数，默认 10000，最大 50000" },
          },
          required: ["path"],
        },
      },
      async execute(input) {
        const filePath = String(input.path ?? "").trim();
        if (!filePath) return "文件路径不能为空";
        const maxChars = Math.min(Number(input.max_chars ?? 10_000), 50_000);
        try {
          const fs = await import("fs");
          if (!fs.existsSync(filePath)) return `文件不存在: ${filePath}`;
          if (!fs.statSync(filePath).isFile()) return `路径不是文件: ${filePath}`;
          const content = fs.readFileSync(filePath, "utf-8");
          const truncated = content.slice(0, maxChars);
          const suffix = content.length > maxChars ? `\n…(已截断，共 ${content.length} 字符)` : "";
          return truncated + suffix;
        } catch (err) {
          return `读取失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    // ── write_file ────────────────────────────────────────────────────────────
    registry.register({
      hint: "将文本内容写入本机文件（可新建或覆盖，支持追加模式）",
      schema: {
        name: "write_file",
        description: "将文本内容写入本机文件。父目录不存在时自动创建。",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string", description: "要写入的文件完整路径" },
            content: { type: "string", description: "要写入的文本内容" },
            append: { type: "boolean", description: "是否追加模式，默认 false（覆盖）" },
          },
          required: ["path", "content"],
        },
      },
      async execute(input) {
        const filePath = String(input.path ?? "").trim();
        const content = String(input.content ?? "");
        const append = Boolean(input.append);
        if (!filePath) return "文件路径不能为空";
        try {
          const fs = await import("fs");
          const path = await import("path");
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, content, { encoding: "utf-8", flag: append ? "a" : "w" });
          const stat = fs.statSync(filePath);
          return `${append ? "追加" : "写入"}成功: ${filePath}（${stat.size} 字节）`;
        } catch (err) {
          return `写入失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    return registry;
  }
}
