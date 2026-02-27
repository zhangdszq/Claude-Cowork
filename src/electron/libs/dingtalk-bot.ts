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

// ─── Tool Registry (OpenClaw-style extensible tool system) ───────────────────

/** Context passed to every tool execution */
interface ToolContext {
  msg: DingtalkMessage;
  /** Send an interim progress message to the current conversation */
  sendProgress: (text: string) => Promise<void>;
}

/** A single registered tool */
interface ToolEntry {
  schema: Anthropic.Tool;
  /** Short one-line hint shown in the system prompt */
  hint: string;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

/**
 * Extensible tool registry — mirrors OpenClaw's createOpenClawTools() pattern.
 * Tools are registered once per bot instance and passed to every Claude API call.
 */
class ToolRegistry {
  private entries = new Map<string, ToolEntry>();

  register(entry: ToolEntry): this {
    this.entries.set(entry.schema.name, entry);
    return this;
  }

  get schemas(): Anthropic.Tool[] {
    return [...this.entries.values()].map((e) => e.schema);
  }

  /** Multiline hint block injected into the Claude system prompt */
  get toolHint(): string {
    if (this.entries.size === 0) return "";
    return [
      "## 可用工具",
      "你可以调用以下工具完成用户请求，无需询问，直接执行：",
      ...[...this.entries.values()].map((e) => `- **${e.schema.name}** — ${e.hint}`),
      "",
      "工具调用流程示例：截图 → take_screenshot → 得到路径 → send_file 发送",
      "工具调用流程示例：查找文件 → bash(find ...) → 得到路径 → send_file 发送",
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

/** V2 access token cache (for api.dingtalk.com/v1.0/* endpoints) */
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

/** V1 access token cache (for oapi.dingtalk.com/* endpoints, e.g. media/upload) */
const tokenCacheV1 = new Map<string, { token: string; expiresAt: number }>();

async function getAccessTokenV1(appKey: string, appSecret: string): Promise<string> {
  const cached = tokenCacheV1.get(appKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const resp = await fetch(
    `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`,
  );
  if (!resp.ok) throw new Error(`DingTalk V1 token fetch failed: HTTP ${resp.status}`);

  const data = (await resp.json()) as { errcode?: number; access_token?: string; expires_in?: number };
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`DingTalk V1 token error: ${JSON.stringify(data)}`);
  }

  tokenCacheV1.set(appKey, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  });
  return data.access_token;
}

/**
 * Upload a file to DingTalk's media server using the old V1 API.
 * Returns media_id on success, null on failure.
 */
async function uploadMediaV1(
  appKey: string,
  appSecret: string,
  filePath: string,
  mediaType: "image" | "voice" | "video" | "file",
): Promise<string | null> {
  const fs = await import("fs");
  const path = await import("path");

  try {
    const token = await getAccessTokenV1(appKey, appSecret);
    const fileBuffer = await fs.promises.readFile(filePath);
    const fileName = path.basename(filePath);
    const fileExt = path.extname(fileName).toLowerCase();
    const mimeByExt: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".amr": "audio/amr",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
    };
    const contentType = mimeByExt[fileExt] ?? "application/octet-stream";
    const boundary = `----DT${Date.now()}`;
    const CRLF = "\r\n";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="media"; filename="${fileName}"${CRLF}` +
        `Content-Type: ${contentType}${CRLF}${CRLF}`,
      ),
      fileBuffer,
      Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
    ]);

    const resp = await fetch(
      `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${mediaType}`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      },
    );

    const data = (await resp.json()) as { errcode?: number; media_id?: string; errmsg?: string };
    if (data.errcode !== 0 || !data.media_id) {
      console.error(`[DingTalk] Media upload V1 failed: ${JSON.stringify(data)}`);
      return null;
    }
    console.log(`[DingTalk] Media uploaded (V1): ${data.media_id}`);
    return data.media_id;
  } catch (err) {
    console.error("[DingTalk] Media upload V1 error:", err);
    return null;
  }
}

// ─── Web utilities ────────────────────────────────────────────────────────────

/** Strip HTML tags and decode common HTML entities */
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

/**
 * Fetch a URL and return readable text content.
 * HTML pages are cleaned to plain text; other content is returned as-is.
 */
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
  if (contentType.includes("text/html")) {
    return stripHtml(text).slice(0, maxChars);
  }
  return text.slice(0, maxChars);
}

/**
 * Search the web via DuckDuckGo.
 * Tries the Instant Answer API first; falls back to HTML result scraping.
 */
async function webSearch(query: string, maxResults = 5): Promise<string> {
  // 1. DuckDuckGo Instant Answer API (facts / definitions)
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
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>;
      };
      const parts: string[] = [];
      if (data.Answer) parts.push(`**答案**: ${data.Answer}`);
      if (data.AbstractText) {
        parts.push(`**摘要**: ${data.AbstractText}`);
        if (data.AbstractURL) parts.push(`来源: ${data.AbstractURL}`);
      }
      if (data.Results && data.Results.length > 0) {
        parts.push("\n**搜索结果**:");
        for (const r of data.Results.slice(0, maxResults)) {
          if (r.Text && r.FirstURL) parts.push(`- ${r.Text.slice(0, 200)}\n  ${r.FirstURL}`);
        }
      }
      const flatTopics = (data.RelatedTopics ?? []).filter((t) => t.Text && t.FirstURL);
      if (flatTopics.length > 0) {
        parts.push("\n**相关话题**:");
        for (const t of flatTopics.slice(0, maxResults)) {
          parts.push(`- ${(t.Text ?? "").slice(0, 200)}\n  ${t.FirstURL}`);
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
  } catch {
    /* fall through to HTML scraping */
  }

  // 2. DuckDuckGo HTML scraping fallback
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
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
  if (count === 0) {
    return `未找到"${query}"相关结果，建议使用 web_fetch 直接访问相关网址。`;
  }
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    const snippet = snippets[i] ? `\n${snippets[i]}` : "";
    const url = urls[i] ? `\n${urls[i]}` : "";
    results.push(`**${i + 1}. ${titles[i]}**${snippet}${url}`);
  }
  return `🔍 搜索"${query}"结果：\n\n${results.join("\n\n")}`;
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

/** Download a media file from DingTalk and save to a temp file; returns the local path */
async function downloadMediaToTempFile(
  appKey: string,
  appSecret: string,
  robotCode: string,
  downloadCode: string,
): Promise<string | null> {
  try {
    const token = await getAccessToken(appKey, appSecret);
    const infoResp = await fetch(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      {
        method: "POST",
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ downloadCode, robotCode }),
      },
    );
    if (!infoResp.ok) {
      const body = await infoResp.text().catch(() => "");
      console.error(`[DingTalk] Image download info failed: HTTP ${infoResp.status} — ${body.slice(0, 200)}`);
      return null;
    }

    const info = (await infoResp.json()) as { downloadUrl?: string };
    const url = info.downloadUrl;
    if (!url) {
      console.error(`[DingTalk] Image download info returned no downloadUrl:`, JSON.stringify(info).slice(0, 200));
      return null;
    }

    const fileResp = await fetch(url);
    if (!fileResp.ok) {
      console.error(`[DingTalk] Image file fetch failed: HTTP ${fileResp.status}`);
      return null;
    }

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    const contentType = fileResp.headers.get("content-type") ?? "image/jpeg";
    const ext = contentType.split(";")[0].trim().split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";

    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    const tmpPath = path.join(os.tmpdir(), `vk-dingtalk-img-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    console.log(`[DingTalk] Image saved to temp file: ${tmpPath} (${(buffer.length / 1024).toFixed(1)}KB)`);
    return tmpPath;
  } catch (err) {
    console.error(`[DingTalk] Image download exception:`, err);
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

// ─── Peer-ID registry ────────────────────────────────────────────────────────
// DingTalk conversationIds are base64-encoded and case-sensitive.
// The framework may lowercase session keys internally, so we preserve originals.

const peerIdMap = new Map<string, string>();

function registerPeerId(originalId: string): void {
  if (!originalId) return;
  peerIdMap.set(originalId.toLowerCase(), originalId);
}

function resolveOriginalPeerId(id: string): string {
  if (!id) return id;
  return peerIdMap.get(id.toLowerCase()) ?? id;
}

// ─── Last-seen conversations ──────────────────────────────────────────────────
// Tracks every conversation (private or group) that has interacted with each bot.
// Used as automatic fallback targets for proactive sends (scenario 2).

interface LastSeenEntry {
  target: string;       // staffId (private) or conversationId (group)
  isGroup: boolean;
  lastSeenAt: number;
}

// key: assistantId → Map<target, entry>
const lastSeenConversations = new Map<string, Map<string, LastSeenEntry>>();

function recordLastSeen(assistantId: string, target: string, isGroup: boolean): void {
  if (!assistantId || !target) return;
  let byAssistant = lastSeenConversations.get(assistantId);
  if (!byAssistant) {
    byAssistant = new Map();
    lastSeenConversations.set(assistantId, byAssistant);
  }
  byAssistant.set(target, { target, isGroup, lastSeenAt: Date.now() });
}

/** Return all targets that have ever chatted with this bot, newest first */
export function getLastSeenTargets(assistantId: string): LastSeenEntry[] {
  const byAssistant = lastSeenConversations.get(assistantId);
  if (!byAssistant) return [];
  return Array.from(byAssistant.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

// ─── Proactive-risk registry ──────────────────────────────────────────────────
// Tracks targets where proactive send failed with a permission error.
// High-risk targets are skipped for 7 days to avoid repeated failure noise.

type ProactiveRiskLevel = "low" | "medium" | "high";

interface ProactiveRiskEntry {
  level: ProactiveRiskLevel;
  reason: string;
  observedAtMs: number;
}

const PROACTIVE_RISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const proactiveRiskStore = new Map<string, ProactiveRiskEntry>();

function proactiveRiskKey(accountId: string, targetId: string): string {
  return `${accountId}:${targetId.trim()}`;
}

function recordProactiveRisk(accountId: string, targetId: string, reason: string): void {
  if (!accountId || !targetId.trim()) return;
  proactiveRiskStore.set(proactiveRiskKey(accountId, targetId), {
    level: "high",
    reason,
    observedAtMs: Date.now(),
  });
}

function getProactiveRisk(accountId: string, targetId: string): ProactiveRiskEntry | null {
  if (!accountId || !targetId.trim()) return null;
  const key = proactiveRiskKey(accountId, targetId);
  const entry = proactiveRiskStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.observedAtMs > PROACTIVE_RISK_TTL_MS) {
    proactiveRiskStore.delete(key);
    return null;
  }
  return entry;
}

function clearProactiveRisk(accountId: string, targetId: string): void {
  proactiveRiskStore.delete(proactiveRiskKey(accountId, targetId));
}

function isProactivePermissionError(code: string | null): boolean {
  if (!code) return false;
  return (
    code.startsWith("Forbidden.AccessDenied") ||
    code === "invalidParameter.userIds.invalid" ||
    code === "invalidParameter.userIds.empty" ||
    code === "invalidParameter.openConversationId.invalid" ||
    code === "invalidParameter.robotCode.empty"
  );
}

function extractErrorCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.code === "string" && d.code.trim()) return d.code.trim();
  if (typeof d.subCode === "string" && d.subCode.trim()) return d.subCode.trim();
  return null;
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
): Promise<{ text: string; filePaths?: string[] }> {
  const rc = opts.robotCode ?? opts.appKey;

  /** Download helper — logs a warn on missing inputs instead of silently skipping */
  async function tryDownload(dc: string | undefined, label: string): Promise<string | null> {
    if (!dc) {
      console.warn(`[DingTalk] ${label}: missing downloadCode`);
      return null;
    }
    if (!rc) {
      console.warn(`[DingTalk] ${label}: robotCode is empty (appKey=${opts.appKey})`);
      return null;
    }
    return downloadMediaToTempFile(opts.appKey, opts.appSecret, rc, dc);
  }

  if (msg.msgtype === "text") {
    // Strip @bot mention prefix in group chats
    const raw = msg.text?.content ?? "";
    const clean = raw.replace(/^@\S+\s*/, "").trim();
    return { text: clean || "[空消息]" };
  }

  if (msg.msgtype === "voice" || msg.msgtype === "audio") {
    const asr = msg.content?.recognition;
    const tmpPath = await tryDownload(msg.content?.downloadCode, "voice");
    if (tmpPath) {
      const textPart = asr ? `[语音] ${asr}` : "用户发来了一条语音消息";
      return { text: textPart, filePaths: [tmpPath] };
    }
    return { text: asr ? `[语音] ${asr}` : "[语音消息（无识别文本）]" };
  }

  if (msg.msgtype === "picture" || msg.msgtype === "image") {
    const tmpPath = await tryDownload(msg.content?.downloadCode, "picture");
    if (tmpPath) {
      return { text: "用户发来了一张图片", filePaths: [tmpPath] };
    }
    return { text: "[图片消息]" };
  }

  if (msg.msgtype === "file") {
    const fileName = msg.content?.fileName ?? "未知文件";
    const tmpPath = await tryDownload(msg.content?.downloadCode, `file(${fileName})`);
    if (tmpPath) {
      return { text: `用户发来了一个文件：${fileName}`, filePaths: [tmpPath] };
    }
    return { text: `[文件: ${fileName}]` };
  }

  if (msg.msgtype === "video") {
    const tmpPath = await tryDownload(msg.content?.downloadCode, "video");
    if (tmpPath) {
      return { text: "用户发来了一段视频", filePaths: [tmpPath] };
    }
    return { text: "[视频消息]" };
  }

  if (msg.msgtype === "richText" && msg.content?.richText) {
    const parts: string[] = [];
    const filePaths: string[] = [];
    for (const part of msg.content.richText) {
      if (part.type === "text" && part.text) {
        parts.push(part.text);
      } else if (part.type === "picture" && rc) {
        const tmpPath = await tryDownload(part.downloadCode, "richText.picture");
        if (tmpPath) {
          filePaths.push(tmpPath);
        } else {
          parts.push("[图片下载失败]");
        }
      } else if (part.type === "at" && part.atName) {
        // skip @mentions
      }
    }
    return { text: parts.join("").trim() || "[富文本消息]", filePaths: filePaths.length > 0 ? filePaths : undefined };
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
  /**
   * Explicit target(s) to send to. Supports:
   *  - staffId / userId  → private message (oToMessages/batchSend)
   *  - conversationId starting with "cid" → group message (groupMessages/send)
   *  - "user:<staffId>" or "group:<conversationId>" prefix to force type
   * Falls back to ownerStaffIds from bot config when omitted.
   */
  targets?: string[];
  title?: string;
}

export interface SendProactiveMediaOptions extends SendProactiveOptions {
  mediaType?: "image" | "voice" | "video" | "file";
}

/** @internal strip user:/group: prefix and detect explicit type */
function stripTargetPrefix(target: string): { targetId: string; isExplicitUser: boolean } {
  if (target.startsWith("user:")) return { targetId: target.slice(5), isExplicitUser: true };
  if (target.startsWith("group:")) return { targetId: target.slice(6), isExplicitUser: false };
  return { targetId: target, isExplicitUser: false };
}

/** @internal detect markdown by content heuristics (same as soimy) */
function isMarkdownText(text: string): boolean {
  return /^[#*>-]|[*_`#[\]]/.test(text) || text.includes("\n");
}

/** @internal core proactive send for a single resolved target */
async function sendProactiveToTarget(
  botOpts: DingtalkBotOptions,
  target: string,
  text: string,
  title: string,
): Promise<void> {
  const token = await getAccessToken(botOpts.appKey, botOpts.appSecret);
  const robotCode = botOpts.robotCode ?? botOpts.appKey;
  const { targetId: rawId, isExplicitUser } = stripTargetPrefix(target);
  const targetId = resolveOriginalPeerId(rawId);
  const isGroup = !isExplicitUser && targetId.startsWith("cid");

  const useMarkdown = isMarkdownText(text);
  const msgKey = useMarkdown ? "sampleMarkdown" : "sampleText";
  const msgParam = useMarkdown
    ? JSON.stringify({ title, text })
    : JSON.stringify({ content: text });

  const url = isGroup
    ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
    : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

  const payload: Record<string, unknown> = { robotCode, msgKey, msgParam };
  if (isGroup) {
    payload.openConversationId = targetId;
  } else {
    payload.userIds = [targetId];
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    let errData: unknown;
    try { errData = JSON.parse(errText); } catch { errData = null; }
    const errCode = extractErrorCode(errData);

    if (isProactivePermissionError(errCode)) {
      recordProactiveRisk(botOpts.assistantId, targetId, errCode ?? "permission-error");
    }
    throw new Error(`HTTP ${resp.status} code=${errCode ?? "?"}: ${errText.slice(0, 200)}`);
  }

  clearProactiveRisk(botOpts.assistantId, targetId);
  console.log(`[DingTalk] Proactive send OK → ${isGroup ? "group" : "user"} ${targetId}`);
}

/**
 * Proactively send a text/markdown message to DingTalk.
 *
 * Target resolution priority:
 *  1. opts.targets — explicit list (staffId, conversationId, or user:/group: prefix)
 *  2. ownerStaffIds — configured on the bot
 *
 * Targets flagged as "high risk" (past permission failures) are skipped to avoid
 * log spam, similar to soimy's proactive-risk-registry behaviour.
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

  let rawTargets: string[];
  if (opts?.targets?.length) {
    rawTargets = opts.targets;
  } else if (botOpts.ownerStaffIds?.length) {
    rawTargets = botOpts.ownerStaffIds;
  } else {
    // Scenario 2: fall back to every conversation that has chatted with this bot
    const lastSeen = getLastSeenTargets(assistantId);
    if (lastSeen.length === 0) {
      return {
        ok: false,
        error:
          "未指定接收者，也未配置 ownerStaffIds，且该 Bot 尚未收到过任何消息。" +
          "请先让对方发一条消息，或在配置中填写 ownerStaffIds。",
      };
    }
    rawTargets = lastSeen.map((e) => e.target);
    console.log(
      `[DingTalk] Proactive: auto-targeting ${rawTargets.length} last-seen conversation(s): ${rawTargets.join(", ")}`,
    );
  }

  const titleFallback = opts?.title ?? botOpts.assistantName;
  const title = isMarkdownText(text)
    ? text.split("\n")[0].replace(/^[#*\s>-]+/, "").slice(0, 20) || titleFallback
    : titleFallback;

  const errors: string[] = [];
  for (const target of rawTargets) {
    const { targetId: rawId } = stripTargetPrefix(target);
    const resolvedId = resolveOriginalPeerId(rawId);
    const risk = getProactiveRisk(assistantId, resolvedId);
    if (risk?.level === "high") {
      console.warn(`[DingTalk] Skipping high-risk target ${resolvedId}: ${risk.reason}`);
      errors.push(`${resolvedId}: skipped (high-risk: ${risk.reason})`);
      continue;
    }

    try {
      await sendProactiveToTarget(botOpts, target, text, title);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[DingTalk] Proactive send failed for ${target}: ${msg}`);
      errors.push(`${target}: ${msg}`);
    }
  }

  if (errors.length === rawTargets.length) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true };
}

/**
 * Upload a local file to DingTalk's media server and then send it proactively.
 * Supports image / voice / video / file (doc, pdf, etc.).
 *
 * Uses the old V1 upload API (oapi.dingtalk.com/media/upload) which returns a
 * media_id that can then be embedded in a proactive message.
 */
export async function sendProactiveMediaDingtalk(
  assistantId: string,
  filePath: string,
  opts?: SendProactiveMediaOptions,
): Promise<{ ok: boolean; error?: string }> {
  const conn = pool.get(assistantId);
  if (!conn) {
    return { ok: false, error: `钉钉 Bot (${assistantId}) 未连接` };
  }

  const botOpts = conn.getOptions();

  let rawTargets: string[];
  if (opts?.targets?.length) {
    rawTargets = opts.targets;
  } else if (botOpts.ownerStaffIds?.length) {
    rawTargets = botOpts.ownerStaffIds;
  } else {
    const lastSeen = getLastSeenTargets(assistantId);
    if (lastSeen.length === 0) {
      return {
        ok: false,
        error: "未指定接收者，也未配置 ownerStaffIds，且该 Bot 尚未收到过任何消息。",
      };
    }
    rawTargets = lastSeen.map((e) => e.target);
  }

  // Detect media type from extension if not specified
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const detectedType: "image" | "voice" | "video" | "file" =
    opts?.mediaType ??
    (["jpg", "jpeg", "png", "gif", "bmp"].includes(ext)
      ? "image"
      : ["mp3", "amr", "wav"].includes(ext)
      ? "voice"
      : ["mp4", "avi", "mov"].includes(ext)
      ? "video"
      : "file");

  const SIZE_LIMITS: Record<string, number> = {
    image: 20 * 1024 * 1024,
    voice: 2 * 1024 * 1024,
    video: 20 * 1024 * 1024,
    file: 20 * 1024 * 1024,
  };

  // Check file size before uploading
  const fs = await import("fs");
  const path = await import("path");

  let fileSize: number;
  try {
    const stat = await fs.promises.stat(filePath);
    fileSize = stat.size;
  } catch {
    return { ok: false, error: `文件不存在或无权访问: ${filePath}` };
  }

  if (fileSize > SIZE_LIMITS[detectedType]) {
    return {
      ok: false,
      error: `文件过大: ${(fileSize / 1024 / 1024).toFixed(1)}MB 超过 ${detectedType} 限制`,
    };
  }

  // Upload to DingTalk media server (must use V1 token for oapi.dingtalk.com)
  const mediaId = await uploadMediaV1(botOpts.appKey, botOpts.appSecret, filePath, detectedType);
  if (!mediaId) {
    return { ok: false, error: "媒体上传失败，请检查应用权限（oapi.dingtalk.com/media/upload）" };
  }

  // Send to each target
  const robotCode = botOpts.robotCode ?? botOpts.appKey;
  const errors: string[] = [];

  for (const target of rawTargets) {
    const { targetId: rawId, isExplicitUser } = stripTargetPrefix(target);
    const targetId = resolveOriginalPeerId(rawId);
    const isGroup = !isExplicitUser && targetId.startsWith("cid");

    const url = isGroup
      ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
      : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

    // soimy pattern: for sampleImageMsg, pass mediaId directly as photoURL.
    // DingTalk V2 proactive API accepts media_id (@lA...) in photoURL field.
    let msgKey: string;
    let msgParam: string;
    const fileName2 = filePath.split("/").pop() ?? "file";
    if (detectedType === "voice") {
      msgKey = "sampleAudio";
      msgParam = JSON.stringify({ mediaId, duration: "0" });
    } else if (detectedType === "image") {
      msgKey = "sampleImageMsg";
      msgParam = JSON.stringify({ photoURL: mediaId });
    } else {
      const fileExt = ext || (detectedType === "video" ? "mp4" : "bin");
      msgKey = "sampleFile";
      msgParam = JSON.stringify({ mediaId, fileName: fileName2, fileType: fileExt });
    }

    const payload: Record<string, unknown> = { robotCode, msgKey, msgParam };
    if (isGroup) {
      payload.openConversationId = targetId;
    } else {
      payload.userIds = [targetId];
    }

    try {
      const token = await getAccessToken(botOpts.appKey, botOpts.appSecret);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[DingTalk] Proactive send fail (${resp.status}) msgKey=${msgKey}: ${errText.slice(0, 200)}`);
      }

      if (!resp.ok) {
        const errText = await resp.text();
        let errData: unknown;
        try { errData = JSON.parse(errText); } catch { errData = null; }
        const errCode = extractErrorCode(errData);
        if (isProactivePermissionError(errCode)) {
          recordProactiveRisk(botOpts.assistantId, targetId, errCode ?? "permission-error");
        }
        throw new Error(`HTTP ${resp.status} code=${errCode ?? "?"}: ${errText.slice(0, 200)}`);
      }
      clearProactiveRisk(botOpts.assistantId, targetId);
      console.log(`[DingTalk] Proactive media sent → ${isGroup ? "group" : "user"} ${targetId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${target}: ${msg}`);
    }
  }

  if (errors.length === rawTargets.length) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true };
}

/**
 * Broadcast a message to the owner of every connected bot.
 * Useful for app-level notifications (e.g. task completed).
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
/** sessionId → number of times the title has been (re)generated */
const titledSessions = new Map<string, number>();

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

/**
 * Asynchronously generate and update a session title using Agent SDK.
 * Re-runs on turn 1 and turn 3 so the title improves as context grows.
 * @param sessionId  - DB session ID
 * @param history    - current full conversation history (user + assistant turns)
 * @param prefix     - channel prefix, e.g. "[钉钉]"
 */
async function updateBotSessionTitle(
  sessionId: string,
  history: ConvMessage[],
  prefix = "[钉钉]",
): Promise<void> {
  const turns = Math.floor(history.length / 2); // each turn = user + assistant
  const prevCount = titledSessions.get(sessionId) ?? 0;

  // Update on turn 1 (after first exchange) and turn 3 (with richer context)
  const shouldUpdate = turns === 1 || (turns === 3 && prevCount < 2);
  if (!shouldUpdate) return;
  titledSessions.set(sessionId, prevCount + 1);

  // Build a compact context from the last 3 turns for the prompt
  const recentTurns = history.slice(-6); // up to 3 user+assistant pairs
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
    sessionStore?.updateSession(sessionId, { title: `${prefix} ${title}` });
    console.log(`[DingTalk] Session title updated (turn ${turns}): "${title}"`);
  } catch (err) {
    console.warn(`[DingTalk] Title generation failed:`, err);
    if (prevCount === 0) {
      sessionStore?.updateSession(sessionId, { title: `${prefix} ${fallback}` });
    }
  }
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

  /** Extensible tool registry — all Claude tool calls go through here */
  private tools!: ToolRegistry;
  /** In-flight message IDs (per-instance) — prevents parallel processing of the same message */
  private inflight = new Set<string>();
  /** Inbound message counters for observability */
  private inboundStats = { received: 0, processed: 0, skipped: 0, toolCalls: 0 };

  constructor(private opts: DingtalkBotOptions) {
    this.tools = this.initTools();
  }

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

    // ── Register peer IDs for proactive reply (soimy pattern) ─────────────────
    // Preserve original case-sensitive conversationId & senderId for later use.
    if (msg.conversationId) registerPeerId(msg.conversationId);
    const senderId = msg.senderStaffId ?? msg.senderId;
    if (senderId) registerPeerId(senderId);

    // ── Record last-seen conversation for automatic proactive targeting ─────────
    const isGroup = msg.conversationType === "2";
    const proactiveTarget = isGroup
      ? (msg.conversationId ?? null)
      : (msg.senderStaffId ?? msg.senderId ?? null);
    if (proactiveTarget) {
      recordLastSeen(this.opts.assistantId, proactiveTarget, isGroup);
    }

    this.inboundStats.received++;

    // ── Deduplication (persistent TTL + in-flight lock) ────────────────────────
    const dedupKey = msg.msgId
      ? `${this.opts.assistantId}:${msg.msgId}`
      : null;

    if (dedupKey) {
      if (isDuplicate(dedupKey)) {
        console.log(`[DingTalk][${this.opts.assistantName}] Dup TTL skip: ${msg.msgId}`);
        this.inboundStats.skipped++;
        return;
      }
      if (this.inflight.has(dedupKey)) {
        console.log(`[DingTalk][${this.opts.assistantName}] In-flight skip: ${msg.msgId}`);
        this.inboundStats.skipped++;
        return;
      }
      markProcessed(dedupKey);
      this.inflight.add(dedupKey);
    }

    // ── Access control ─────────────────────────────────────────────────────────
    if (!isAllowed(msg, this.opts)) {
      if (dedupKey) this.inflight.delete(dedupKey);
      return;
    }

    // ── sessionWebhook expiry check ────────────────────────────────────────────
    if (
      msg.sessionWebhookExpiredTime &&
      Date.now() > msg.sessionWebhookExpiredTime
    ) {
      console.warn("[DingTalk] sessionWebhook expired, skipping message");
      return;
    }

    // ── Extract text/media content ─────────────────────────────────────────────
    let extracted: { text: string; filePaths?: string[] };
    try {
      extracted = await extractContent(msg, this.opts);
    } catch (err) {
      console.error("[DingTalk] Content extraction error:", err);
      extracted = { text: "[消息处理失败]" };
    }

    if (!extracted.text) return;

    // Append file paths to the text so Agent SDK can read/view them
    if (extracted.filePaths && extracted.filePaths.length > 0) {
      const pathsNote = extracted.filePaths.map((p: string) => `文件路径: ${p}`).join("\n");
      extracted = { ...extracted, text: `${extracted.text}\n\n${pathsNote}` };
    }

    console.log(`[DingTalk] Message (${msg.msgtype}): ${extracted.text.slice(0, 100)}`);

    // ── Built-in /myid command (only exact-match commands stay hardcoded) ──────
    // Everything else (screenshot, find file, etc.) is handled via Claude tool_use.
    const cmdText = extracted.text.trim();

    if (cmdText === "/myid" || cmdText === "/我的id" || cmdText === "/我的ID") {
      const staffId = msg.senderStaffId ?? msg.senderId ?? "（未知）";
      const convId = msg.conversationId ?? "（未知）";
      const isGroup = msg.conversationType === "2";
      const reply = [
        "**你的钉钉 ID 信息**",
        "",
        `- **staffId**（填入 ownerStaffIds）：\`${staffId}\``,
        isGroup ? `- **群 conversationId**（群推送用）：\`${convId}\`` : "",
        "",
        "复制上方 ID 填入 Bot 配置 → 高级设置 → 我的 StaffId，即可接收主动推送。",
      ].filter((l) => l !== undefined && !(isGroup === false && l.includes("群"))).join("\n");
      await this.sendMarkdown(msg.sessionWebhook, reply).catch(() => {});
      return;
    }

    // ── Generate and deliver reply ─────────────────────────────────────────────
    this.inboundStats.processed++;
    console.log(
      `[DingTalk][${this.opts.assistantName}] Processing (rcv=${this.inboundStats.received} proc=${this.inboundStats.processed} skip=${this.inboundStats.skipped} tools=${this.inboundStats.toolCalls})`,
    );
    try {
      await this.generateAndDeliver(msg, extracted.text);
    } catch (err) {
      console.error("[DingTalk] Reply generation error:", err);
      if (!msg.sessionWebhookExpiredTime || Date.now() <= msg.sessionWebhookExpiredTime) {
        await this.sendMarkdown(
          msg.sessionWebhook,
          "抱歉，处理您的消息时遇到了问题，请稍后再试。",
        ).catch(() => {});
      }
    } finally {
      if (dedupKey) this.inflight.delete(dedupKey);
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

    history.push({ role: "user", content: userText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = buildSmartMemoryContext(userText);
    const basePersona =
      this.opts.persona?.trim() ||
      `你是 ${this.opts.assistantName}，一个智能助手，请简洁有用地回答问题。`;

    // Strict output rules: no internal monologue, no step-by-step narration.
    const outputRules = `## 回复规范（必须遵守）
- 直接给出结果，不要叙述你的思考过程或执行步骤
- 调用工具时保持沉默，只在工具全部完成后给出一句话结论
- 截图/发文件类任务：工具执行完只需回复"已发送"或简短说明，不要写"我先截图再上传再发送…"
- 禁止把工具调用的中间状态、路径、API 返回值等细节写进最终回复
- 如果任务失败，简短说明原因即可，无需描述每个步骤`;

    const system = [basePersona, outputRules, memoryContext, this.tools.toolHint]
      .filter(Boolean)
      .join("\n\n");

    let replyText: string;

    if (provider === "codex") {
      replyText = await this.runCodex(system, history, userText);
    } else {
      replyText = await this.runClaude(
        system,
        history,
        userText,
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

    // Async title update after reply — uses full history for better context
    updateBotSessionTitle(sessionId, history, `[钉钉]`).catch(() => {});

    await this.sendMarkdown(msg.sessionWebhook, replyText);
  }

  // ── Tool registry factory (OpenClaw-style: register once, run via ToolRegistry) ─

  private initTools(): ToolRegistry {
    const registry = new ToolRegistry();
    // Capture `this` for closures
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // ── take_screenshot ────────────────────────────────────────────────────
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

    // ── send_file ────────────────────────────────────────────────────────
    registry.register({
      hint: "将本机文件通过钉钉发送给当前用户（支持图/PDF/视频，自动压缩超大文件）",
      schema: {
        name: "send_file",
        description:
          "通过钉钉将本地文件发送给当前对话的用户。支持图片（png/jpg）、PDF、文档、视频等。" +
          "file_path 必须是本机可读取的完整路径。" +
          "超出大小限制时会自动处理：图片自动压缩（macOS sips），其他文件自动 zip 压缩。" +
          "压缩后仍超限才会返回提示。",
        input_schema: {
          type: "object" as const,
          properties: {
            file_path: { type: "string", description: "要发送的文件的完整本地路径" },
          },
          required: ["file_path"],
        },
      },
      async execute(input, ctx) {
        const msg = ctx.msg;
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        const path = await import("path");
        const fs = await import("fs");

        const filePath = String(input.file_path ?? "");
        if (!filePath || !fs.existsSync(filePath)) return `文件不存在: ${filePath}`;

        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        const mediaType: "image" | "voice" | "video" | "file" =
          ["jpg", "jpeg", "png", "gif", "bmp"].includes(ext) ? "image" :
          ["mp3", "amr", "wav"].includes(ext) ? "voice" :
          ["mp4", "avi", "mov"].includes(ext) ? "video" : "file";

        const SIZE_LIMITS: Record<string, number> = {
          image: 20 * 1024 * 1024,
          voice: 2 * 1024 * 1024,
          video: 20 * 1024 * 1024,
          file: 20 * 1024 * 1024,
        };

        const tempFiles: string[] = [];
        const cleanup = () => {
          const toDelete = filePath.includes("vk-shot-") ? [filePath, ...tempFiles] : tempFiles;
          for (const f of toDelete) {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
          }
        };

        let sendPath = filePath;
        const stat = fs.statSync(filePath);
        const limit = SIZE_LIMITS[mediaType];

        if (stat.size > limit) {
          const os2 = await import("os");
          const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

          if (mediaType === "image") {
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
              if (newStat.size <= limit) {
                console.log(`[DingTalk] Image compressed: ${sizeMB}MB → ${(newStat.size / 1024 / 1024).toFixed(1)}MB`);
                sendPath = compressedPath;
              } else {
                cleanup();
                return `图片压缩后仍超过 20MB（${(newStat.size / 1024 / 1024).toFixed(1)}MB），建议先裁剪或降低分辨率。`;
              }
            } catch {
              cleanup();
              return `图片 ${sizeMB}MB 超过 20MB 限制，压缩失败，请先手动压缩。`;
            }
          } else if (mediaType === "voice") {
            cleanup();
            return `语音文件 ${sizeMB}MB 超过 2MB 限制，请裁剪后再发。`;
          } else {
            const zipPath = path.join(
              (await import("os")).tmpdir(),
              `vk-${path.basename(filePath)}-${Date.now()}.zip`,
            );
            tempFiles.push(zipPath);
            try {
              await execAsync(`cd "${path.dirname(filePath)}" && zip "${zipPath}" "${path.basename(filePath)}"`);
              const zipStat = fs.statSync(zipPath);
              if (zipStat.size <= SIZE_LIMITS.file) {
                console.log(`[DingTalk] File zipped: ${sizeMB}MB → ${(zipStat.size / 1024 / 1024).toFixed(1)}MB`);
                sendPath = zipPath;
              } else {
                cleanup();
                return `文件 ${sizeMB}MB 压缩后仍超过 20MB，建议用网盘分享链接代替，或通过 bash 上传 OSS 后发链接。`;
              }
            } catch {
              cleanup();
              return `文件 ${sizeMB}MB 超过 20MB 限制，且 zip 压缩失败，建议改用网盘分享。`;
            }
          }
        }

        // Upload to DingTalk media server (V1 API — requires V1 token)
        const sendExt = sendPath.split(".").pop()?.toLowerCase() ?? ext;
        const sendMediaType: "image" | "voice" | "video" | "file" =
          ["jpg", "jpeg", "png", "gif", "bmp"].includes(sendExt) ? "image" :
          ["mp3", "amr", "wav"].includes(sendExt) ? "voice" :
          ["mp4", "avi", "mov"].includes(sendExt) ? "video" : "file";

        const mediaId = await uploadMediaV1(self.opts.appKey, self.opts.appSecret, sendPath, sendMediaType);
        if (!mediaId) {
          cleanup();
          return `媒体上传失败，请检查应用权限（oapi.dingtalk.com）`;
        }

        // Try sessionWebhook first — add V2 token header (soimy always adds it for media)
        const webhookExpired = msg.sessionWebhookExpiredTime && Date.now() > msg.sessionWebhookExpiredTime;
        if (!webhookExpired && msg.sessionWebhook) {
          try {
            const webhookToken = await getAccessToken(self.opts.appKey, self.opts.appSecret);
            const body = sendMediaType === "image"
              ? { msgtype: "image", image: { media_id: mediaId } }
              : sendMediaType === "voice"
              ? { msgtype: "voice", voice: { media_id: mediaId, duration: 1 } }
              : { msgtype: "file", file: { media_id: mediaId } };

            const resp = await fetch(msg.sessionWebhook, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": webhookToken,
              },
              body: JSON.stringify(body),
            });
            const respText = await resp.text();
            if (resp.ok) {
              console.log(`[DingTalk][send_file] webhook ok: ${path.basename(sendPath)}`);
              cleanup();
              return `文件已发送: ${path.basename(sendPath)}`;
            }
            console.error(`[DingTalk][send_file] webhook fail (${resp.status}): ${respText}`);
          } catch (err) {
            console.error("[DingTalk][send_file] webhook error:", err);
          }
        }

        // Fallback: proactive API — soimy pattern: pass mediaId directly as photoURL for images
        const robotCode = self.opts.robotCode ?? self.opts.appKey;
        const sender = msg.senderStaffId ?? msg.senderId ?? "";
        const isGroup = msg.conversationType === "2";
        const resolvedTarget = resolveOriginalPeerId(sender || msg.conversationId || "");
        const apiUrl = isGroup
          ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
          : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

        const fileName = path.basename(filePath);
        const fileExt = ext || "bin";
        let msgKey: string;
        let msgParam: string;
        if (sendMediaType === "voice") {
          msgKey = "sampleAudio";
          msgParam = JSON.stringify({ mediaId, duration: "1" });
        } else if (sendMediaType === "image") {
          msgKey = "sampleImageMsg";
          msgParam = JSON.stringify({ photoURL: mediaId });
        } else {
          msgKey = "sampleFile";
          msgParam = JSON.stringify({ mediaId, fileName, fileType: fileExt });
        }

        const payload: Record<string, unknown> = { robotCode, msgKey, msgParam };
        if (isGroup) payload.openConversationId = resolvedTarget;
        else payload.userIds = [resolvedTarget];

        try {
          const token = await getAccessToken(self.opts.appKey, self.opts.appSecret);
          const resp = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
            body: JSON.stringify(payload),
          });
          const respText = await resp.text();
          cleanup();
          if (resp.ok) return `文件已发送: ${path.basename(sendPath)}`;
          return `发送失败 (HTTP ${resp.status}): ${respText.slice(0, 200)}`;
        } catch (err) {
          cleanup();
          return `发送异常: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    // ── bash ────────────────────────────────────────────────────────────
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

    // ── send_message ─────────────────────────────────────────────────────
    registry.register({
      hint: "向当前对话发送一条进度通知或中间结果消息（支持 Markdown）",
      schema: {
        name: "send_message",
        description:
          "向当前钉钉对话立即发送一条文本/Markdown 消息。适合在执行长任务时告知用户进度，" +
          "或在最终回复前推送中间结果。注意：你的最终文字回复也会自动发送，请勿重复内容。",
        input_schema: {
          type: "object" as const,
          properties: {
            text: { type: "string", description: "要发送的消息内容（支持 Markdown）" },
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

    // ── web_fetch ────────────────────────────────────────────────────────
    registry.register({
      hint: "抓取网页 URL 内容，返回可读文本（HTML 自动清除标签）",
      schema: {
        name: "web_fetch",
        description:
          "抓取指定 URL 的内容并以纯文本返回。HTML 页面会自动清除标签，返回可读正文。" +
          "可用于查看文章、文档、API 响应等。默认最多返回 8000 字符。",
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

    // ── web_search ────────────────────────────────────────────────────────
    registry.register({
      hint: "用 DuckDuckGo 搜索网络，返回 top-N 结果摘要和链接",
      schema: {
        name: "web_search",
        description:
          "通过 DuckDuckGo 搜索网络，返回 top 5 搜索结果（标题、摘要、URL）。" +
          "如需查看某个结果的详细内容，再用 web_fetch 工具抓取对应 URL。",
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

    // ── read_file ─────────────────────────────────────────────────────────
    registry.register({
      hint: "读取本机文本文件内容（最多 10000 字符）",
      schema: {
        name: "read_file",
        description:
          "读取本机上的文本文件内容并返回。适合查看配置文件、日志、代码等文本文件。" +
          "最多返回 10000 字符。不支持二进制文件（图片/PDF 等请用 send_file）。",
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

    // ── write_file ────────────────────────────────────────────────────────
    registry.register({
      hint: "将文本内容写入本机文件（可新建或覆盖，支持追加模式）",
      schema: {
        name: "write_file",
        description:
          "将文本内容写入本机文件。父目录不存在时自动创建。" +
          "可用于保存笔记、生成报告、写入配置等。写入后返回文件路径和字节数。",
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

  // ── Claude ───────────────────────────────────────────────────────────────────

  private async runClaude(
    system: string,
    history: ConvMessage[],
    userText: string,
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

    messages.push({ role: "user", content: userText });

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

        updateBotSessionTitle(sessionId, history, `[钉钉]`).catch(() => {});

        return "__CARD_DELIVERED__";
      } catch (err) {
        console.error("[DingTalk] Card mode failed, falling back to markdown:", err);
        // Fall through to regular markdown reply
      }
    }

    // ── Agentic tool-use loop (OpenClaw pattern) ───────────────────────────────
    // Claude decides which tools to call; ToolRegistry dispatches and executes them.
    const MAX_TOOL_TURNS = 8;
    let toolTurns = 0;
    const toolSchemas = this.tools.schemas;
    const ctx: ToolContext = {
      msg,
      sendProgress: (text: string) => this.sendMarkdown(msg.sessionWebhook, text).catch(() => {}),
    };

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

      // Append assistant turn (includes tool_use blocks)
      messages.push({ role: "assistant", content: response.content });

      // Execute each tool and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tb of toolUseBlocks) {
        this.inboundStats.toolCalls++;
        const inputPreview = JSON.stringify(tb.input).slice(0, 120);
        console.log(`[DingTalk][tool] ${tb.name}(${inputPreview})`);
        let result: string;
        try {
          result = await this.tools.run(tb.name, tb.input as Record<string, unknown>, ctx);
        } catch (err) {
          result = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
        }
        console.log(`[DingTalk][tool] ${tb.name} → ${result.slice(0, 150)}`);
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: result });
      }

      // Feed results back to Claude for next reasoning step
      messages.push({ role: "user", content: toolResults });
      toolTurns++;
    }

    return "抱歉，工具调用次数超过上限，请换个方式提问。";
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
