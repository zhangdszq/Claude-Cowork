/**
 * DingTalk Stream Mode Bot Service
 *
 * Full rewrite incorporating features from soimy/openclaw-channel-dingtalk:
 * - Exponential backoff + jitter reconnection with configurable params
 * - AI Card streaming mode (real-time streaming via DingTalk interactive cards)
 * - Media handling: voice ASR passthrough, image download + vision, file description
 * - Access control: dmPolicy (open/allowlist), groupPolicy (open/allowlist), allowFrom
 * - Message deduplication by msgId (5-min TTL)
 * - sessionWebhook expiry detection
 * - DingTalk OAuth2 access token caching (for Card API)
 * - Anthropic client caching (per-assistant, invalidated on settings change)
 */
import WebSocket from "ws";
import Anthropic from "@anthropic-ai/sdk";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import { EventEmitter } from "events";
import { networkInterfaces } from "os";
import { randomUUID } from "crypto";
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
  // Core credentials
  appKey: string;
  appSecret: string;
  /** For Card API and media download — defaults to appKey */
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  // Identity
  assistantId: string;
  assistantName: string;
  persona?: string;
  // AI config
  provider?: "claude" | "codex";
  model?: string;
  defaultCwd?: string;
  // Reply mode
  messageType?: "markdown" | "card";
  cardTemplateId?: string;
  /** Card template content field key — defaults to "msgContent" */
  cardTemplateKey?: string;
  // Access control
  dmPolicy?: "open" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  /** Allowlisted staff IDs (dmPolicy=allowlist) or conversationIds (groupPolicy=allowlist) */
  allowFrom?: string[];
  // Connection robustness
  /** Max reconnect attempts after initial connection (default: 10) */
  maxConnectionAttempts?: number;
  /** Initial reconnect delay in ms (default: 1000) */
  initialReconnectDelay?: number;
  /** Max reconnect delay in ms (default: 60000) */
  maxReconnectDelay?: number;
  /** Jitter factor 0–1 (default: 0.3) */
  reconnectJitter?: number;
  /**
   * Owner staff ID(s) for proactive push messages.
   * Used by sendProactiveDingtalkMessage() — e.g. notify yourself after a task completes.
   */
  ownerStaffIds?: string[];
}

interface StreamFrame {
  specVersion: string;
  type: string;
  headers: Record<string, string>;
  data: string;
}

/** Full DingTalk inbound message (Stream mode) */
interface DingtalkMessage {
  msgId?: string;
  msgtype: string;
  createAt?: number;
  conversationType: string;  // "1" = private, "2" = group
  conversationId?: string;
  conversationTitle?: string;
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId?: string;
  sessionWebhook: string;
  sessionWebhookExpiredTime?: number;
  // Text
  text?: { content: string };
  // Media / rich content
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;  // Voice ASR result
    richText?: Array<{
      type: string;
      text?: string;
      atName?: string;
      downloadCode?: string;
    }>;
  };
}

interface ConvMessage {
  role: "user" | "assistant";
  content: string;
}

interface AICardInstance {
  outTrackId: string;
  cardInstanceId: string;
  templateKey: string;
}

// ─── DingTalk API helpers ─────────────────────────────────────────────────────

const DINGTALK_API = "https://api.dingtalk.com";

/** Access token cache: key = `${appKey}` */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
  const cached = tokenCache.get(appKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const resp = await fetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey, appSecret, grantType: "client_credentials" }),
  });
  if (!resp.ok) throw new Error(`DingTalk token fetch failed: HTTP ${resp.status}`);

  const data = (await resp.json()) as { accessToken?: string; expireIn?: number };
  if (!data.accessToken) throw new Error("DingTalk token response missing accessToken");

  tokenCache.set(appKey, {
    token: data.accessToken,
    expiresAt: Date.now() + (data.expireIn ?? 7200) * 1000,
  });
  return data.accessToken;
}

async function createAICard(
  accessToken: string,
  robotCode: string,
  templateId: string,
  templateKey: string,
  msg: DingtalkMessage,
  initialContent: string,
): Promise<AICardInstance> {
  const outTrackId = randomUUID();
  const isGroup = msg.conversationType === "2";

  let openSpaceId: string;
  let openSpaceModel: Record<string, unknown>;

  if (isGroup && msg.conversationId) {
    openSpaceId = `dtv1.card//IM_GROUP.${msg.conversationId}`;
    openSpaceModel = { imGroupOpenSpaceModel: { supportForward: true } };
  } else {
    openSpaceId = `dtv1.card//IM_ROBOT.${msg.chatbotUserId ?? robotCode}`;
    openSpaceModel = { imRobotOpenSpaceModel: { spaceType: "IM_ROBOT" } };
  }

  const payload = {
    cardTemplateId: templateId,
    outTrackId,
    openSpaceId,
    ...openSpaceModel,
    cardData: { cardParamMap: { [templateKey]: initialContent } },
    userIdType: 0,
    robotCode,
    pullStrategy: false,
  };

  const resp = await fetch(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": accessToken,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Card create failed HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { result?: { cardInstanceId: string } };
  if (!data.result?.cardInstanceId) throw new Error("Card create: missing cardInstanceId");

  return { outTrackId, cardInstanceId: data.result.cardInstanceId, templateKey };
}

async function streamAICard(
  card: AICardInstance,
  accessToken: string,
  content: string,
  isFinalize: boolean,
): Promise<void> {
  const resp = await fetch(`${DINGTALK_API}/v1.0/card/streaming`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": accessToken,
    },
    body: JSON.stringify({
      outTrackId: card.outTrackId,
      guid: card.cardInstanceId,
      key: card.templateKey,
      content,
      isFull: true,
      isFinalize,
      isError: false,
    }),
  });
  if (!resp.ok) {
    console.error(`[DingTalk] Card stream update failed: HTTP ${resp.status}`);
  }
}

/** Download a media file from DingTalk and return base64 data for vision */
async function downloadMediaAsBase64(
  appKey: string,
  appSecret: string,
  robotCode: string,
  downloadCode: string,
): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const token = await getAccessToken(appKey, appSecret);
    const infoResp = await fetch(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download?downloadCode=${encodeURIComponent(downloadCode)}&robotCode=${encodeURIComponent(robotCode)}`,
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
    if (!infoResp.ok) return null;

    const info = (await infoResp.json()) as { downloadUrl?: string };
    const url = info.downloadUrl;
    if (!url) return null;

    const fileResp = await fetch(url);
    if (!fileResp.ok) return null;

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    const contentType = fileResp.headers.get("content-type") ?? "image/jpeg";
    const mimeType = contentType.split(";")[0].trim();
    return { base64: buffer.toString("base64"), mimeType };
  } catch {
    return null;
  }
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

function isAllowed(msg: DingtalkMessage, opts: DingtalkBotOptions): boolean {
  const isGroup = msg.conversationType === "2";

  if (isGroup) {
    if ((opts.groupPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      if (!msg.conversationId || !allowed.includes(msg.conversationId)) {
        console.log(`[DingTalk] Group ${msg.conversationId} blocked by groupPolicy=allowlist`);
        return false;
      }
    }
  } else {
    if ((opts.dmPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      const uid = msg.senderStaffId ?? msg.senderId;
      if (!uid || !allowed.includes(uid)) {
        console.log(`[DingTalk] User ${uid} blocked by dmPolicy=allowlist`);
        return false;
      }
    }
  }
  return true;
}

// ─── Message content extraction ───────────────────────────────────────────────

async function extractContent(
  msg: DingtalkMessage,
  opts: DingtalkBotOptions,
): Promise<{ text: string; images?: Array<{ base64: string; mimeType: string }> }> {
  const rc = opts.robotCode ?? opts.appKey;

  if (msg.msgtype === "text") {
    // Strip @bot mention prefix in group chats
    const raw = msg.text?.content ?? "";
    const clean = raw.replace(/^@\S+\s*/, "").trim();
    return { text: clean || "[空消息]" };
  }

  if (msg.msgtype === "voice" || msg.msgtype === "audio") {
    const asr = msg.content?.recognition;
    return { text: asr ? `[语音] ${asr}` : "[语音消息（无识别文本）]" };
  }

  if (msg.msgtype === "picture" || msg.msgtype === "image") {
    const dc = msg.content?.downloadCode;
    if (dc && rc) {
      const img = await downloadMediaAsBase64(opts.appKey, opts.appSecret, rc, dc);
      if (img?.mimeType.startsWith("image/")) {
        return { text: "[图片消息，请描述图片内容]", images: [img] };
      }
    }
    return { text: "[图片消息]" };
  }

  if (msg.msgtype === "richText" && msg.content?.richText) {
    const parts: string[] = [];
    const images: Array<{ base64: string; mimeType: string }> = [];
    for (const part of msg.content.richText) {
      if (part.type === "text" && part.text) {
        parts.push(part.text);
      } else if (part.type === "picture" && part.downloadCode && rc) {
        const img = await downloadMediaAsBase64(opts.appKey, opts.appSecret, rc, part.downloadCode);
        if (img?.mimeType.startsWith("image/")) {
          images.push(img);
        } else {
          parts.push("[图片]");
        }
      } else if (part.type === "at" && part.atName) {
        // skip @mentions
      }
    }
    return { text: parts.join("").trim() || "[富文本消息]", images: images.length > 0 ? images : undefined };
  }

  if (msg.msgtype === "file") {
    return { text: `[文件: ${msg.content?.fileName ?? "未知文件"}]` };
  }

  if (msg.msgtype === "video") {
    return { text: "[视频消息]" };
  }

  // Fallback
  const raw = msg.text?.content ?? "";
  return { text: raw.trim() || `[${msg.msgtype} 消息]` };
}

// ─── Status emitter ───────────────────────────────────────────────────────────

const statusEmitter = new EventEmitter();

export function onDingtalkBotStatusChange(
  cb: (assistantId: string, status: DingtalkBotStatus, detail?: string) => void,
): () => void {
  statusEmitter.on("status", cb);
  return () => statusEmitter.off("status", cb);
}

function emit(assistantId: string, status: DingtalkBotStatus, detail?: string) {
  statusEmitter.emit("status", assistantId, status, detail);
}

// ─── Injected session store ───────────────────────────────────────────────────

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
  await conn.start();
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

// ─── Proactive (outbound) messaging ──────────────────────────────────────────

export interface SendProactiveOptions {
  /** Staff IDs to send to. Falls back to ownerStaffIds configured on the bot. */
  staffIds?: string[];
  title?: string;
}

/**
 * Proactively send a markdown message to one or more DingTalk users.
 * Requires the bot to be connected (to obtain appKey/appSecret) OR
 * pass credentials directly.
 */
export async function sendProactiveDingtalkMessage(
  assistantId: string,
  text: string,
  opts?: SendProactiveOptions,
): Promise<{ ok: boolean; error?: string }> {
  const conn = pool.get(assistantId);
  if (!conn) {
    return { ok: false, error: `钉钉 Bot (${assistantId}) 未连接` };
  }

  const botOpts = conn.getOptions();
  const robotCode = botOpts.robotCode ?? botOpts.appKey;
  const staffIds = opts?.staffIds?.length
    ? opts.staffIds
    : (botOpts.ownerStaffIds ?? []);

  if (staffIds.length === 0) {
    return { ok: false, error: "未配置接收者 staffId（ownerStaffIds），无法主动推送" };
  }

  try {
    const token = await getAccessToken(botOpts.appKey, botOpts.appSecret);
    const resp = await fetch(`${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        robotCode,
        userIds: staffIds,
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({
          title: opts?.title ?? botOpts.assistantName,
          text,
        }),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[DingTalk] Proactive send failed: HTTP ${resp.status} ${errText}`);
      return { ok: false, error: `发送失败 HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    console.log(`[DingTalk] Proactive message sent to ${staffIds.join(",")}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Send a proactive message to the owner of EVERY connected bot.
 * Useful for broadcast notifications (e.g. "screenshot analysis done").
 */
export async function broadcastDingtalkMessage(
  text: string,
  opts?: SendProactiveOptions,
): Promise<void> {
  for (const [assistantId] of pool) {
    await sendProactiveDingtalkMessage(assistantId, text, opts).catch((err) =>
      console.error(`[DingTalk] Broadcast failed for ${assistantId}:`, err),
    );
  }
}

// ─── Conversation history & session management ────────────────────────────────

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
  if (!sessionStore) throw new Error("[DingTalk] SessionStore not injected");
  const session = sessionStore.createSession({
    title: `[钉钉] ${assistantName}`,
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
  sessionStore?.updateSession(sessionId, { title: `[钉钉] ${title}` });
}

// ─── Anthropic client cache ───────────────────────────────────────────────────

/** Per-assistantId client cache; cleared when API settings change */
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
  if (cached && cached.apiKey === apiKey && cached.baseURL === baseURL) {
    return cached.client;
  }

  if (!apiKey) throw new Error("未配置 Anthropic API Key，请在设置中填写。");
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined });
  anthropicClients.set(assistantId, { client, apiKey, baseURL });
  return client;
}

// ─── DingtalkConnection ───────────────────────────────────────────────────────

class DingtalkConnection {
  status: DingtalkBotStatus = "disconnected";
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private everConnected = false;
  private reconnectAttempts = 0;

  constructor(private opts: DingtalkBotOptions) {}

  getOptions(): DingtalkBotOptions {
    return this.opts;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.everConnected = false;
    this.reconnectAttempts = 0;
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
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.status = "disconnected";
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    this.status = "connecting";
    emit(this.opts.assistantId, "connecting");

    const resp = await fetch(`${DINGTALK_API}/v1.0/gateway/connections/open`, {
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

    const bodyText = await resp.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      throw new Error(`网关返回非 JSON 响应 (HTTP ${resp.status}): ${bodyText.slice(0, 200)}`);
    }

    if (!resp.ok || body.code || !body.endpoint) {
      const code = (body.code as string | undefined) ?? resp.status;
      const msg =
        (body.message as string | undefined) ??
        (body.errmsg as string | undefined) ??
        bodyText.slice(0, 200);
      throw new Error(
        `网关连接失败 [${code}]: ${msg}\n提示：请确认钉钉应用已开启「机器人」能力并选择「Stream 模式」。`,
      );
    }

    const { endpoint, ticket } = body as { endpoint: string; ticket: string };
    console.log(`[DingTalk] Gateway OK, endpoint=${endpoint}`);

    const wsUrl = endpoint.includes("?")
      ? `${endpoint}&ticket=${encodeURIComponent(ticket)}`
      : `${endpoint}?ticket=${encodeURIComponent(ticket)}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { ticket },
        perMessageDeflate: false,
        followRedirects: true,
      });
      this.ws = ws;

      const onOpen = () => {
        ws.off("error", onError);
        this.everConnected = true;
        this.reconnectAttempts = 0;
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
        if (!this.stopped && this.everConnected) {
          this.status = "error";
          emit(this.opts.assistantId, "error", `连接断开 (code=${code})，正在重连…`);
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err: Error) => {
        if (this.status === "connected") {
          console.error("[DingTalk] WebSocket error:", err.message);
          this.status = "error";
          emit(this.opts.assistantId, "error", err.message);
        }
      });
    });
  }

  // ── Exponential backoff reconnect ────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const maxAttempts = this.opts.maxConnectionAttempts ?? 10;
    if (this.reconnectAttempts >= maxAttempts) {
      this.status = "error";
      emit(
        this.opts.assistantId,
        "error",
        `已达最大重连次数 (${maxAttempts})，请手动重新连接`,
      );
      return;
    }

    const initialDelay = this.opts.initialReconnectDelay ?? 1000;
    const maxDelay = this.opts.maxReconnectDelay ?? 60_000;
    const jitter = this.opts.reconnectJitter ?? 0.3;

    const base = Math.min(initialDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    const jitterRange = base * jitter;
    const delay = Math.round(base + (Math.random() * 2 - 1) * jitterRange);

    this.reconnectAttempts++;
    console.log(
      `[DingTalk] Reconnect attempt ${this.reconnectAttempts}/${maxAttempts} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error("[DingTalk] Reconnect failed:", err.message);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  // ── Frame handling ───────────────────────────────────────────────────────────

  private async handleFrame(raw: string): Promise<void> {
    let frame: StreamFrame;
    try {
      frame = JSON.parse(raw) as StreamFrame;
    } catch {
      return;
    }

    if (frame.type === "PING") {
      this.ack(frame.headers.messageId, frame.headers.topic ?? "");
      return;
    }

    if (frame.type !== "CALLBACK") return;

    const topic = frame.headers.topic;
    if (topic !== "/v1.0/im/bot/messages/get") return;

    this.ack(frame.headers.messageId, topic);

    let msg: DingtalkMessage;
    try {
      msg = JSON.parse(frame.data) as DingtalkMessage;
    } catch {
      return;
    }

    // ── Deduplication ──────────────────────────────────────────────────────────
    const dedupKey = msg.msgId
      ? `${this.opts.assistantId}:${msg.msgId}`
      : null;

    if (dedupKey) {
      if (isDuplicate(dedupKey)) {
        console.log(`[DingTalk] Duplicate message skipped: ${msg.msgId}`);
        return;
      }
      markProcessed(dedupKey);
    }

    // ── Access control ─────────────────────────────────────────────────────────
    if (!isAllowed(msg, this.opts)) return;

    // ── sessionWebhook expiry check ────────────────────────────────────────────
    if (
      msg.sessionWebhookExpiredTime &&
      Date.now() > msg.sessionWebhookExpiredTime
    ) {
      console.warn("[DingTalk] sessionWebhook expired, skipping message");
      return;
    }

    // ── Extract text/media content ─────────────────────────────────────────────
    let extracted: { text: string; images?: Array<{ base64: string; mimeType: string }> };
    try {
      extracted = await extractContent(msg, this.opts);
    } catch (err) {
      console.error("[DingTalk] Content extraction error:", err);
      extracted = { text: "[消息处理失败]" };
    }

    if (!extracted.text) return;

    console.log(`[DingTalk] Message (${msg.msgtype}): ${extracted.text.slice(0, 100)}`);

    // ── Generate and deliver reply ─────────────────────────────────────────────
    try {
      await this.generateAndDeliver(msg, extracted.text, extracted.images);
    } catch (err) {
      console.error("[DingTalk] Reply generation error:", err);
      // Best-effort error reply via sessionWebhook (if not expired)
      if (!msg.sessionWebhookExpiredTime || Date.now() <= msg.sessionWebhookExpiredTime) {
        await this.sendMarkdown(
          msg.sessionWebhook,
          "抱歉，处理您的消息时遇到了问题，请稍后再试。",
        ).catch(() => {});
      }
    }
  }

  private ack(messageId: string, topic: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        code: 200,
        headers: { messageId, topic, contentType: "application/json" },
        message: "OK",
        data: "",
      }),
    );
  }

  // ── Generate reply and deliver (card or markdown) ────────────────────────────

  private async generateAndDeliver(
    msg: DingtalkMessage,
    userText: string,
    userImages?: Array<{ base64: string; mimeType: string }>,
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
    const system = `${basePersona}\n\n${memoryContext}`;

    let replyText: string;

    if (provider === "codex") {
      replyText = await this.runCodex(system, history, userText);
    } else {
      replyText = await this.runClaude(
        system,
        history,
        userText,
        userImages,
        msg,
        sessionId,
      );
      // Card mode handles sending internally; return early
      if (replyText === "__CARD_DELIVERED__") {
        return;
      }
    }

    history.push({ role: "assistant", content: replyText });
    this.persistReply(sessionId, replyText, userText);

    await this.sendMarkdown(msg.sessionWebhook, replyText);
  }

  // ── Claude ───────────────────────────────────────────────────────────────────

  private async runClaude(
    system: string,
    history: ConvMessage[],
    userText: string,
    userImages: Array<{ base64: string; mimeType: string }> | undefined,
    msg: DingtalkMessage,
    sessionId: string,
  ): Promise<string> {
    const client = getAnthropicClient(this.opts.assistantId);
    const model = this.opts.model || "claude-opus-4-5";

    // Build message list (history already includes current user message)
    const messages: Anthropic.MessageParam[] = history.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Add current user turn (with optional images)
    if (userImages && userImages.length > 0) {
      const contentParts: Anthropic.ContentBlockParam[] = [];
      for (const img of userImages) {
        if (img.mimeType.startsWith("image/")) {
          contentParts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: img.base64,
            },
          });
        }
      }
      contentParts.push({ type: "text", text: userText });
      messages.push({ role: "user", content: contentParts });
    } else {
      messages.push({ role: "user", content: userText });
    }

    // ── Card streaming mode ────────────────────────────────────────────────────
    const useCard =
      this.opts.messageType === "card" &&
      !!this.opts.cardTemplateId;

    if (useCard) {
      try {
        const accessToken = await getAccessToken(this.opts.appKey, this.opts.appSecret);
        const card = await createAICard(
          accessToken,
          this.opts.robotCode ?? this.opts.appKey,
          this.opts.cardTemplateId!,
          this.opts.cardTemplateKey ?? "msgContent",
          msg,
          "🤔 正在思考…",
        );

        let accum = "";
        let lastUpdate = 0;
        const THROTTLE_MS = 500;

        const stream = client.messages.stream({
          model,
          max_tokens: 2048,
          system,
          messages,
        });

        for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            accum += event.delta.text;
            const now = Date.now();
            if (now - lastUpdate >= THROTTLE_MS) {
              lastUpdate = now;
              await streamAICard(card, accessToken, accum, false).catch(() => {});
            }
          }
        }

        const finalText = accum.trim() || "抱歉，无法生成回复。";
        await streamAICard(card, accessToken, finalText, true).catch(() => {});

        history.push({ role: "assistant", content: finalText });
        this.persistReply(sessionId, finalText, userText);

        return "__CARD_DELIVERED__";
      } catch (err) {
        console.error("[DingTalk] Card mode failed, falling back to markdown:", err);
        // Fall through to regular markdown reply
      }
    }

    // ── Regular (non-streaming) markdown reply ─────────────────────────────────
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system,
      messages,
    });

    return response.content[0].type === "text"
      ? response.content[0].text
      : "抱歉，无法生成回复。";
  }

  // ── Codex ────────────────────────────────────────────────────────────────────

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
      appendDailyMemory(
        `\n## [钉钉] ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${userText}\n**${this.opts.assistantName}**: ${replyText}\n`,
      );
    }
  }

  // ── Send markdown via sessionWebhook ─────────────────────────────────────────

  private async sendMarkdown(webhook: string, text: string): Promise<void> {
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
      console.error(`[DingTalk] Reply failed: HTTP ${resp.status} ${await resp.text()}`);
    }
  }
}
