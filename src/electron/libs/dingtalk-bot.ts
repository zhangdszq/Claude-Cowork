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

  // Upload to DingTalk media server
  let mediaId: string;
  try {
    const token = await getAccessToken(botOpts.appKey, botOpts.appSecret);
    const fileName = path.basename(filePath);
    const fileBuffer = await fs.promises.readFile(filePath);

    // Build multipart form data manually (no FormData class needed)
    const boundary = `----DingTalkUpload${Date.now()}`;
    const CRLF = "\r\n";
    const pre =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="media"; filename="${fileName}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`;
    const post = `${CRLF}--${boundary}--${CRLF}`;
    const body = Buffer.concat([
      Buffer.from(pre),
      fileBuffer,
      Buffer.from(post),
    ]);

    const uploadUrl = `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${detectedType}`;
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });

    const uploadData = (await uploadResp.json()) as { errcode?: number; media_id?: string };
    if (uploadData.errcode !== 0 || !uploadData.media_id) {
      return { ok: false, error: `媒体上传失败: ${JSON.stringify(uploadData)}` };
    }
    mediaId = uploadData.media_id;
    console.log(`[DingTalk] Media uploaded: ${mediaId} (${detectedType})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `媒体上传异常: ${msg}` };
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

    let msgKey: string;
    let msgParam: string;
    if (detectedType === "image") {
      msgKey = "sampleImageMsg";
      msgParam = JSON.stringify({ photoURL: mediaId });
    } else if (detectedType === "voice") {
      msgKey = "sampleAudio";
      msgParam = JSON.stringify({ mediaId, duration: "0" });
    } else {
      const fileName = filePath.split("/").pop() ?? "file";
      const fileExt = ext || (detectedType === "video" ? "mp4" : "bin");
      msgKey = "sampleFile";
      msgParam = JSON.stringify({ mediaId, fileName, fileType: fileExt });
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
    const toolsHint = `
## 可用工具
你可以调用以下工具来完成用户的请求，无需询问，直接执行即可：
- **take_screenshot** — 截取当前桌面截图，返回文件路径
- **send_file** — 把本机文件通过钉钉发送给用户（需先有文件路径）
- **bash** — 在本机执行 shell 命令（查找文件、读取内容、获取系统信息等）

典型工作流（截图）：先调用 take_screenshot → 拿到路径 → 调用 send_file 发送。
典型工作流（找文件）：先调用 bash 找到路径 → 再调用 send_file 发送。`;
    const system = `${basePersona}\n\n${memoryContext}\n\n${toolsHint}`;

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

  // ── Tool execution (OpenClaw-style: Claude decides, framework executes) ──────

  private async executeTool(
    name: string,
    input: Record<string, unknown>,
    msg: DingtalkMessage,
  ): Promise<string> {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    if (name === "take_screenshot") {
      const filePath = path.join(os.tmpdir(), `vk-shot-${Date.now()}.png`);
      const platform = process.platform;
      await this.sendMarkdown(msg.sessionWebhook, "📸 正在截图…").catch(() => {});
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
    }

    if (name === "send_file") {
      const filePath = String(input.file_path ?? "");
      if (!filePath || !fs.existsSync(filePath)) {
        return `文件不存在: ${filePath}`;
      }
      const target = msg.senderStaffId ?? msg.senderId ?? "";
      const result = await sendProactiveMediaDingtalk(this.opts.assistantId, filePath, {
        targets: target ? [target] : undefined,
      });
      // Clean up temp screenshots after sending
      if (filePath.includes("vk-shot-") && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
      return result.ok ? `文件已发送: ${path.basename(filePath)}` : `发送失败: ${result.error}`;
    }

    if (name === "bash") {
      const command = String(input.command ?? "").trim();
      if (!command) return "命令为空";
      try {
        const { stdout, stderr } = await execAsync(command, { timeout: 15_000 });
        const out = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
        return out.slice(0, 3000) || "(no output)";
      } catch (err) {
        const e = err as { message?: string; stdout?: string; stderr?: string };
        return `命令失败: ${e.message}\n${e.stderr ?? ""}`.slice(0, 1000);
      }
    }

    return `未知工具: ${name}`;
  }

  // ── Claude tools definition ───────────────────────────────────────────────────

  private get claudeTools(): Anthropic.Tool[] {
    return [
      {
        name: "take_screenshot",
        description:
          "截取当前桌面屏幕截图。返回截图的临时文件路径，之后可用 send_file 发送给用户。",
        input_schema: { type: "object" as const, properties: {}, required: [] },
      },
      {
        name: "send_file",
        description:
          "通过钉钉将本地文件发送给当前对话的用户。支持图片（png/jpg）、PDF、文档等。" +
          "file_path 必须是本机可读取的完整路径。",
        input_schema: {
          type: "object" as const,
          properties: {
            file_path: { type: "string", description: "要发送的文件的完整本地路径" },
          },
          required: ["file_path"],
        },
      },
      {
        name: "bash",
        description:
          "在本机执行 bash 命令（macOS/Linux）或 PowerShell（Windows）。" +
          "适合：查找文件（find、ls）、读取文本内容（cat）、获取系统信息等。" +
          "超时 15 秒，输出限制 3000 字符。",
        input_schema: {
          type: "object" as const,
          properties: {
            command: { type: "string", description: "要执行的 shell 命令" },
          },
          required: ["command"],
        },
      },
    ];
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

    // ── Agentic tool-use loop (OpenClaw pattern) ───────────────────────────────
    // Claude decides which tools to call; we execute and feed results back.
    const MAX_TOOL_TURNS = 6;
    let toolTurns = 0;

    while (toolTurns < MAX_TOOL_TURNS) {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages,
        tools: this.claudeTools,
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

      // Append assistant turn with tool calls
      messages.push({ role: "assistant", content: response.content });

      // Execute each tool and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tb of toolUseBlocks) {
        console.log(`[DingTalk] Tool call: ${tb.name}(${JSON.stringify(tb.input)})`);
        let result: string;
        try {
          result = await this.executeTool(tb.name, tb.input as Record<string, unknown>, msg);
        } catch (err) {
          result = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
        }
        console.log(`[DingTalk] Tool result (${tb.name}): ${result.slice(0, 100)}`);
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: result });
      }

      // Feed results back to Claude
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

  // ── Built-in screenshot command ───────────────────────────────────────────────

  private async handleScreenshot(msg: DingtalkMessage): Promise<void> {
    const os = process.platform;
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const path = await import("path");
    const fs = await import("fs");
    const tmpDir = (await import("os")).tmpdir();
    const filePath = path.join(tmpDir, `vk-screenshot-${Date.now()}.png`);

    // Notify user that screenshot is being taken
    await this.sendMarkdown(msg.sessionWebhook, "📸 正在截图…").catch(() => {});

    try {
      // OS-specific screenshot commands
      if (os === "darwin") {
        await execAsync(`screencapture -x "${filePath}"`);
      } else if (os === "win32") {
        // PowerShell screenshot on Windows
        await execAsync(
          `powershell -command "Add-Type -AssemblyName System.Windows.Forms; ` +
          `$screen=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
          `$bmp=New-Object System.Drawing.Bitmap($screen.Width,$screen.Height); ` +
          `$g=[System.Drawing.Graphics]::FromImage($bmp); ` +
          `$g.CopyFromScreen($screen.Left,$screen.Top,0,0,$screen.Size); ` +
          `$bmp.Save('${filePath}',[System.Drawing.Imaging.ImageFormat]::Png)"`,
        );
      } else {
        // Linux: try gnome-screenshot, then scrot as fallback
        await execAsync(`gnome-screenshot -f "${filePath}" 2>/dev/null || scrot "${filePath}"`);
      }

      if (!fs.existsSync(filePath)) {
        throw new Error("截图文件未生成");
      }

      // Upload to DingTalk and send
      const result = await sendProactiveMediaDingtalk(this.opts.assistantId, filePath, {
        targets: [msg.senderStaffId ?? msg.senderId ?? ""],
      });

      if (result.ok) {
        await this.sendMarkdown(msg.sessionWebhook, "✅ 截图已发送").catch(() => {});
      } else {
        await this.sendMarkdown(
          msg.sessionWebhook,
          `❌ 截图发送失败：${result.error}`,
        ).catch(() => {});
      }
    } catch (err) {
      const msg2 = err instanceof Error ? err.message : String(err);
      console.error("[DingTalk] Screenshot failed:", msg2);
      await this.sendMarkdown(
        msg.sessionWebhook,
        `❌ 截图失败：${msg2}`,
      ).catch(() => {});
    } finally {
      // Clean up temp file
      try {
        const fs2 = await import("fs");
        if (fs2.existsSync(filePath)) fs2.unlinkSync(filePath);
      } catch { /* ignore */ }
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
