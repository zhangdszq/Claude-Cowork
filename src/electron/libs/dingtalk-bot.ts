/**
 * DingTalk Stream Mode Bot Service
 *
 * Uses DingTalk's WebSocket Stream API to receive bot messages and route them
 * through the configured assistant, then replies back via sessionWebhook.
 */
import WebSocket from "ws";
import Anthropic from "@anthropic-ai/sdk";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import { EventEmitter } from "events";
import { networkInterfaces } from "os";
import { loadUserSettings } from "./user-settings.js";
import { getCodexBinaryPath } from "./codex-runner.js";
import { buildSmartMemoryContext, appendDailyMemory } from "./memory-store.js";
import type { SessionStore } from "./session-store.js";

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const iface of list ?? []) {
      if (!iface.internal && iface.family === "IPv4") return iface.address;
    }
  }
  return "127.0.0.1";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type DingtalkBotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface DingtalkBotOptions {
  appKey: string;
  appSecret: string;
  assistantId: string;
  assistantName: string;
  persona?: string;
  provider?: "claude" | "codex";
  model?: string;
  defaultCwd?: string;
}

interface StreamFrame {
  specVersion: string;
  type: string;
  headers: Record<string, string>;
  data: string;
}

interface DingtalkMessage {
  msgtype: string;
  text?: { content: string };
  content?: string;
  senderStaffId: string;
  senderNick?: string;
  sessionWebhook: string;
  conversationType: string;
  sessionWebhookExpiredTime?: number;
}

interface ConvMessage {
  role: "user" | "assistant";
  content: string;
}

// ─── Status emitter ───────────────────────────────────────────────────────────

const statusEmitter = new EventEmitter();

export function onDingtalkBotStatusChange(
  cb: (assistantId: string, status: DingtalkBotStatus, detail?: string) => void
): () => void {
  statusEmitter.on("status", cb);
  return () => statusEmitter.off("status", cb);
}

function emit(assistantId: string, status: DingtalkBotStatus, detail?: string) {
  statusEmitter.emit("status", assistantId, status, detail);
}

// ─── Injected session store (set by main.ts before any bot starts) ───────────

let sessionStore: SessionStore | null = null;

export function setSessionStore(store: SessionStore): void {
  sessionStore = store;
}

// ─── Connection pool ──────────────────────────────────────────────────────────

const pool = new Map<string, DingtalkConnection>();

export async function startDingtalkBot(opts: DingtalkBotOptions): Promise<void> {
  stopDingtalkBot(opts.assistantId);
  const conn = new DingtalkConnection(opts);
  pool.set(opts.assistantId, conn);
  await conn.start(); // throws on failure; start() removes itself from pool on error
}

export function stopDingtalkBot(assistantId: string): void {
  const conn = pool.get(assistantId);
  if (conn) {
    conn.stop();
    pool.delete(assistantId);
  }
  emit(assistantId, "disconnected");
}

export function getDingtalkBotStatus(assistantId: string): DingtalkBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

// ─── Conversation history (per assistant) ────────────────────────────────────

const histories = new Map<string, ConvMessage[]>();
const MAX_TURNS = 10;

// Maps assistantId → sessionId in the shared SessionStore
const botSessionIds = new Map<string, string>();

function getHistory(assistantId: string): ConvMessage[] {
  if (!histories.has(assistantId)) histories.set(assistantId, []);
  return histories.get(assistantId)!;
}

/** Return (and lazily create) the persistent session for this assistant's bot */
function getBotSession(
  assistantId: string,
  assistantName: string,
  provider: "claude" | "codex",
  model: string | undefined,
  cwd: string | undefined,
): string {
  if (botSessionIds.has(assistantId)) return botSessionIds.get(assistantId)!;
  if (!sessionStore) throw new Error("[DingTalk] SessionStore not injected – call setSessionStore() first.");
  const session = sessionStore.createSession({
    title: `[钉钉] ${assistantName}`,  // placeholder; updated after first message
    assistantId,
    provider: provider as "claude" | "codex",
    model,
    cwd,
  });
  botSessionIds.set(assistantId, session.id);
  return session.id;
}

/** Track whether the session title has been updated from the placeholder */
const titledSessions = new Set<string>();

/**
 * Asynchronously generate a concise title using the app's standard
 * generateSessionTitle (which uses the assistant's configured Agent SDK),
 * then update the session. Falls back to truncated first message on failure.
 */
async function updateBotSessionTitle(
  sessionId: string,
  firstMessage: string,
): Promise<void> {
  if (titledSessions.has(sessionId)) return;
  titledSessions.add(sessionId);

  const fallback = firstMessage.slice(0, 40).trim() + (firstMessage.length > 40 ? "…" : "");
  let title = fallback;

  try {
    const { generateSessionTitle } = await import("../api/services/runner.js");
    const generated = await generateSessionTitle(
      `请根据以下对话内容，生成一个简短的中文标题（10字以内，不加引号），直接输出标题：\n${firstMessage}`
    );
    if (generated && generated !== "New Session") title = generated;
  } catch {
    // keep fallback
  }

  sessionStore?.updateSession(sessionId, { title: `[钉钉] ${title}` });
}

// ─── DingtalkConnection ───────────────────────────────────────────────────────

class DingtalkConnection {
  status: DingtalkBotStatus = "disconnected";
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** True once the first WebSocket open event fires – reconnect only after this */
  private everConnected = false;

  constructor(private opts: DingtalkBotOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.everConnected = false;
    try {
      await this.connect();
    } catch (err) {
      // Initial connection failed – stop timers and remove from pool
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
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.status = "disconnected";
  }

  // ── Connect ──────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    this.status = "connecting";
    emit(this.opts.assistantId, "connecting");

    // Step 1: request gateway endpoint + ticket
    const resp = await fetch("https://api.dingtalk.com/v1.0/gateway/connections/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.opts.appKey,
        clientSecret: this.opts.appSecret,
        subscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }],
        ua: "dingtalk-stream-sdk-nodejs/1.1.0",
        localIp: getLocalIp(),
      }),
    });

    // Parse response – DingTalk may return 200 with error body OR 4xx
    const bodyText = await resp.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      throw new Error(`网关返回非 JSON 响应 (HTTP ${resp.status}): ${bodyText.slice(0, 200)}`);
    }

    if (!resp.ok || body.code || !body.endpoint) {
      const code = (body.code as string | undefined) ?? resp.status;
      const msg = (body.message as string | undefined) ?? (body.errmsg as string | undefined) ?? bodyText.slice(0, 200);
      throw new Error(
        `网关连接失败 [${code}]: ${msg}\n` +
        `提示：请确认钉钉应用已开启「机器人」能力并选择「Stream 模式」。`
      );
    }

    const { endpoint, ticket } = body as { endpoint: string; ticket: string };

    console.log(`[DingTalk] Gateway OK, endpoint=${endpoint}`);

    // DingTalk accepts the ticket either as a header OR as a URL query param.
    // Some gateway versions reject custom WebSocket headers – append to URL instead.
    const wsUrl = endpoint.includes("?")
      ? `${endpoint}&ticket=${encodeURIComponent(ticket)}`
      : `${endpoint}?ticket=${encodeURIComponent(ticket)}`;

    // Step 2: open WebSocket, wait for open/error (synchronous result)
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { ticket },          // send in both places for compatibility
        perMessageDeflate: false,
        followRedirects: true,
      });
      this.ws = ws;

      const onOpen = () => {
        ws.off("error", onError);
        this.everConnected = true;
        this.status = "connected";
        emit(this.opts.assistantId, "connected");
        console.log(`[DingTalk] Connected: assistant=${this.opts.assistantId}`);
        resolve();
      };

      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(new Error(`WebSocket 握手失败: ${err.message}`));
      };

      ws.once("open", onOpen);
      ws.once("error", onError);

      // After connection is established, set up ongoing handlers
      ws.on("message", async (raw: Buffer | string) => {
        try {
          await this.handleFrame(raw.toString());
        } catch (err) {
          console.error("[DingTalk] Frame handling error:", err);
        }
      });

      ws.on("close", (code: number) => {
        console.log(`[DingTalk] WebSocket closed (code=${code})`);
        this.ws = null;
        // Only reconnect if we had a successful connection before (not on initial failure)
        if (!this.stopped && this.everConnected) {
          this.status = "error";
          emit(this.opts.assistantId, "error", `连接断开 (code=${code})，5秒后重连…`);
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err: Error) => {
        // Post-connection errors (after open)
        if (this.status === "connected") {
          console.error("[DingTalk] WebSocket error:", err.message);
          this.status = "error";
          emit(this.opts.assistantId, "error", err.message);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(console.error);
    }, 5000);
  }

  // ── Frame handling ───────────────────────────────────────────────────────────

  private async handleFrame(raw: string): Promise<void> {
    let frame: StreamFrame;
    try {
      frame = JSON.parse(raw) as StreamFrame;
    } catch {
      return;
    }

    // Respond to system pings
    if (frame.type === "PING") {
      this.ack(frame.headers.messageId, frame.headers.topic ?? "");
      return;
    }

    if (frame.type !== "CALLBACK") return;

    const topic = frame.headers.topic;
    if (topic !== "/v1.0/im/bot/messages/get") return;

    // ACK immediately so DingTalk doesn't retry
    this.ack(frame.headers.messageId, topic);

    // Parse message payload
    let msg: DingtalkMessage;
    try {
      msg = JSON.parse(frame.data) as DingtalkMessage;
    } catch {
      return;
    }

    const userText = (msg.text?.content ?? msg.content ?? "").trim();
    if (!userText || !msg.sessionWebhook) return;

    console.log(`[DingTalk] Message: ${userText}`);

    // Generate AI reply
    let reply: string;
    try {
      reply = await this.generateReply(userText);
    } catch (err) {
      console.error("[DingTalk] AI error:", err);
      reply = "抱歉，处理您的消息时遇到了问题，请稍后再试。";
    }

    // Send reply
    await this.sendReply(msg.sessionWebhook, reply);
  }

  private ack(messageId: string, topic: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        code: 200,
        headers: { messageId, topic, contentType: "application/json" },
        message: "OK",
        data: "",
      })
    );
  }

  // ── AI reply ─────────────────────────────────────────────────────────────────

  private async generateReply(userMessage: string): Promise<string> {
    const history = getHistory(this.opts.assistantId);
    const provider = this.opts.provider ?? "claude";
    const cwd = this.opts.defaultCwd;

    // Ensure a persistent session exists for this assistant's bot conversation
    const sessionId = getBotSession(
      this.opts.assistantId,
      this.opts.assistantName,
      provider,
      this.opts.model,
      cwd,
    );

    // Persist user message to session store (matches UserPromptMessage shape)
    sessionStore?.recordMessage(sessionId, { type: "user_prompt", prompt: userMessage });

    // On the first message, asynchronously update session title (fire-and-forget)
    updateBotSessionTitle(sessionId, userMessage).catch(() => {});

    history.push({ role: "user", content: userMessage });
    while (history.length > MAX_TURNS * 2) history.shift();

    // Inject assistant memory into the system prompt
    const memoryContext = buildSmartMemoryContext(userMessage);
    const settings = loadUserSettings();
    const basePersona =
      this.opts.persona?.trim() ||
      `你是 ${this.opts.assistantName}，一个智能助手，请简洁有用地回答问题。`;
    const system = `${basePersona}\n\n${memoryContext}`;

    let replyText: string;

    // ── Claude (Anthropic) ───────────────────────────────────────
    if (provider === "claude") {
      const apiKey =
        settings.anthropicAuthToken ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        undefined;
      if (!apiKey) throw new Error("未配置 Anthropic API Key，请在设置中填写。");

      const client = new Anthropic({ apiKey, baseURL: settings.anthropicBaseUrl || undefined });
      const response = await client.messages.create({
        model: this.opts.model || "claude-opus-4-5",
        max_tokens: 2048,
        system,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      });

      replyText =
        response.content[0].type === "text" ? response.content[0].text : "抱歉，无法生成回复。";
    } else {
      // ── Codex (OpenAI via OAuth) ────────────────────────────────
      const codexOpts: CodexOptions = {};
      const codexPath = getCodexBinaryPath();
      if (codexPath) codexOpts.codexPathOverride = codexPath;

      const codex = new Codex(codexOpts);
      const threadOpts: ThreadOptions = {
        model: this.opts.model || "gpt-5.3-codex",
        workingDirectory: cwd || process.cwd(),
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
      replyText = textParts.join("").trim() || "抱歉，无法生成回复。";
    }

    history.push({ role: "assistant", content: replyText });

    // Persist assistant reply to session store (matches SDKMessage assistant shape)
    sessionStore?.recordMessage(sessionId, {
      type: "assistant",
      uuid: crypto.randomUUID(),
      message: {
        id: crypto.randomUUID(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: replyText }],
        model: this.opts.model || "",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } as unknown as import("../types.js").StreamMessage);

    // Write conversation to today's daily memory
    appendDailyMemory(
      `\n## [钉钉] ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${userMessage}\n**${this.opts.assistantName}**: ${replyText}\n`
    );

    return replyText;
  }

  // ── Send reply ───────────────────────────────────────────────────────────────

  private async sendReply(webhook: string, text: string): Promise<void> {
    // DingTalk markdown supports most basic formatting
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: this.opts.assistantName,
          text,
        },
      }),
    });

    if (!resp.ok) {
      console.error("[DingTalk] Reply failed:", resp.status, await resp.text());
    }
  }
}
