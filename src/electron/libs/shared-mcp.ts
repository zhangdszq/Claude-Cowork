/**
 * Shared MCP server for all agent contexts (main window, DingTalk, Feishu).
 * Exposes common tools: scheduler, web_search, web_fetch, take_screenshot,
 * news_search, news_latest (6551 OpenNews), twitter_user_tweets, twitter_search
 * (6551 OpenTwitter).
 *
 * Claude provider: injected via mcpServers option in query().
 * Codex provider: tools are accessible via bash directly (no MCP needed).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { app } from "electron";
import {
  addScheduledTask,
  loadScheduledTasks,
  deleteScheduledTask,
} from "./scheduler.js";
import {
  readSop,
  writeSop,
  listSops,
  searchSops,
  writeWorkingMemory,
  readWorkingMemory,
  appendDailyMemory,
  ScopedMemory,
} from "./memory-store.js";

// ── Helpers ────────────────────────────────────────────────────────────────

// ── 6551 API (OpenNews + OpenTwitter) ───────────────────────────────────────

const API_BASE = "https://ai.6551.io";
let _cached6551Token: string | null = null;

function get6551Token(): string {
  if (_cached6551Token) return _cached6551Token;
  try {
    const configPath = app.isPackaged
      ? join(process.resourcesPath, "config", "builtin-mcp-servers.json")
      : join(app.getAppPath(), "config", "builtin-mcp-servers.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { token?: string };
      if (cfg.token) {
        _cached6551Token = cfg.token;
        return cfg.token;
      }
    }
  } catch { /* ignore */ }
  return "";
}

async function api6551<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = get6551Token();
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`6551 API ${method} ${path} → HTTP ${resp.status}`);
  return resp.json() as Promise<T>;
}

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
  if (contentType.includes("text/html")) {
    return stripHtml(text).slice(0, maxChars);
  }
  return text.slice(0, maxChars);
}

async function webSearch(query: string, maxResults = 5): Promise<string> {
  // 1. DuckDuckGo Instant Answer API
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
      const flatTopics = (data.RelatedTopics ?? []).filter(
        (t): t is { Text: string; FirstURL: string } => !!(t.Text && t.FirstURL),
      );
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
    try {
      urls.push(decodeURIComponent(m[1]));
    } catch {
      urls.push(m[1]);
    }
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

/** Wrap a plain string result into MCP CallToolResult format. */
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── Tool definitions ────────────────────────────────────────────────────────

// ── OpenNews tools ──────────────────────────────────────────────────────────

const newsLatestTool = tool(
  "news_latest",
  "获取最新加密货币/财经资讯（来自 6551 OpenNews）。返回文章标题、AI 评分、交易信号（多/空/中性）和摘要。" +
  "适合场景：了解市场最新动态、查看重要新闻、获取 AI 评级的高影响力资讯。",
  {
    limit: z.number().optional().describe("返回条数，默认 10，最大 50"),
    coin: z.string().optional().describe("按代币筛选，如 BTC、ETH、SOL（可选）"),
    signal: z.enum(["long", "short", "neutral"]).optional().describe("按交易信号筛选（可选）"),
    min_score: z.number().optional().describe("最低 AI 评分（0-100），只返回高于此分的资讯（可选）"),
  },
  async (input) => {
    try {
      const limit = Math.min(Number(input.limit ?? 10), 50);
      const body: Record<string, unknown> = { limit, page: 1 };
      if (input.coin) body.coins = [String(input.coin).toUpperCase()];

      const data = await api6551<{ list?: unknown[] }>("POST", "/open/news_search", body);
      let items = (data?.list ?? []) as Array<{
        text?: string; ts?: number; newsType?: string; engineType?: string;
        aiRating?: { score?: number; signal?: string; summary?: string; enSummary?: string };
        link?: string; coins?: Array<{ symbol?: string }>;
      }>;

      if (input.signal) items = items.filter(i => i.aiRating?.signal === input.signal);
      if (input.min_score != null) items = items.filter(i => (i.aiRating?.score ?? 0) >= Number(input.min_score));

      if (items.length === 0) return ok("暂无符合条件的资讯。");

      const lines = items.slice(0, limit).map((item, idx) => {
        const time = item.ts ? new Date(item.ts).toLocaleString("zh-CN", { hour12: false }) : "";
        const score = item.aiRating?.score != null ? `评分:${item.aiRating.score}` : "";
        const signal = item.aiRating?.signal ? `信号:${item.aiRating.signal}` : "";
        const coins = item.coins?.map(c => c.symbol).filter(Boolean).join("/") ?? "";
        const summary = item.aiRating?.summary || item.aiRating?.enSummary || "";
        const meta = [score, signal, coins, item.newsType, time].filter(Boolean).join(" | ");
        return `**${idx + 1}. ${item.text ?? ""}**\n${meta}${summary ? `\n${summary}` : ""}${item.link ? `\n${item.link}` : ""}`;
      });
      return ok(`📰 最新资讯（${lines.length} 条）\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`获取资讯失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const newsSearchTool = tool(
  "news_search",
  "按关键词搜索加密货币/财经资讯（来自 6551 OpenNews）。支持关键词、代币、评分过滤。",
  {
    query: z.string().describe("搜索关键词"),
    coin: z.string().optional().describe("按代币筛选，如 BTC、ETH（可选）"),
    limit: z.number().optional().describe("返回条数，默认 10，最大 30"),
  },
  async (input) => {
    try {
      const query = String(input.query ?? "").trim();
      if (!query) return ok("搜索词不能为空");
      const limit = Math.min(Number(input.limit ?? 10), 30);
      const body: Record<string, unknown> = { q: query, limit, page: 1 };
      if (input.coin) body.coins = [String(input.coin).toUpperCase()];

      const data = await api6551<{ list?: unknown[] }>("POST", "/open/news_search", body);
      const items = (data?.list ?? []) as Array<{
        text?: string; ts?: number; newsType?: string;
        aiRating?: { score?: number; signal?: string; summary?: string };
        link?: string; coins?: Array<{ symbol?: string }>;
      }>;

      if (items.length === 0) return ok(`未找到"${query}"相关资讯。`);

      const lines = items.map((item, idx) => {
        const score = item.aiRating?.score != null ? `评分:${item.aiRating.score}` : "";
        const signal = item.aiRating?.signal ? `信号:${item.aiRating.signal}` : "";
        const coins = item.coins?.map(c => c.symbol).filter(Boolean).join("/") ?? "";
        const meta = [score, signal, coins, item.newsType].filter(Boolean).join(" | ");
        return `**${idx + 1}. ${item.text ?? ""}**\n${meta}${item.aiRating?.summary ? `\n${item.aiRating.summary}` : ""}`;
      });
      return ok(`🔍 "${query}" 相关资讯（${lines.length} 条）\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`搜索资讯失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// ── OpenTwitter tools ────────────────────────────────────────────────────────

const twitterUserTweetsTool = tool(
  "twitter_user_tweets",
  "获取指定 Twitter/X 用户的最近推文（来自 6551 OpenTwitter）。",
  {
    username: z.string().describe("Twitter 用户名，不带 @ 符号，如 elonmusk"),
    limit: z.number().optional().describe("返回条数，默认 10，最大 50"),
    include_retweets: z.boolean().optional().describe("是否包含转推，默认 false"),
  },
  async (input) => {
    try {
      const username = String(input.username ?? "").replace(/^@/, "").trim();
      if (!username) return ok("用户名不能为空");
      const limit = Math.min(Number(input.limit ?? 10), 50);

      const data = await api6551<{ list?: unknown[] }>("POST", "/open/twitter_user_tweets", {
        username,
        maxResults: limit,
        product: "Latest",
        includeReplies: false,
        includeRetweets: input.include_retweets ?? false,
      });
      const tweets = (data?.list ?? []) as Array<{
        id?: string; text?: string; createdAt?: string;
        retweetCount?: number; favoriteCount?: number; replyCount?: number;
      }>;

      if (tweets.length === 0) return ok(`@${username} 暂无推文。`);

      const lines = tweets.map((t, idx) => {
        const time = t.createdAt ? new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
        const stats = [`❤️ ${t.favoriteCount ?? 0}`, `🔁 ${t.retweetCount ?? 0}`, `💬 ${t.replyCount ?? 0}`].join("  ");
        return `**${idx + 1}.** ${t.text ?? ""}\n${stats}  ${time}`;
      });
      return ok(`🐦 @${username} 最近 ${lines.length} 条推文\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`获取推文失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const twitterSearchTool = tool(
  "twitter_search",
  "搜索 Twitter/X 推文（来自 6551 OpenTwitter）。支持关键词、用户、话题标签、互动量过滤。",
  {
    keywords: z.string().optional().describe("搜索关键词（可选）"),
    from_user: z.string().optional().describe("指定发推用户，不带 @（可选）"),
    hashtag: z.string().optional().describe("话题标签，不带 #（可选）"),
    min_likes: z.number().optional().describe("最低点赞数，用于筛选热门推文（可选）"),
    limit: z.number().optional().describe("返回条数，默认 10，最大 50"),
    product: z.enum(["Top", "Latest"]).optional().describe("排序方式：Top=热门，Latest=最新，默认 Top"),
  },
  async (input) => {
    try {
      const limit = Math.min(Number(input.limit ?? 10), 50);
      const body: Record<string, unknown> = {
        maxResults: limit,
        product: input.product ?? "Top",
        excludeReplies: true,
        excludeRetweets: true,
      };
      if (input.keywords) body.keywords = String(input.keywords);
      if (input.from_user) body.fromUser = String(input.from_user).replace(/^@/, "");
      if (input.hashtag) body.hashtag = String(input.hashtag).replace(/^#/, "");
      if (input.min_likes) body.minLikes = Number(input.min_likes);

      if (!body.keywords && !body.fromUser && !body.hashtag) {
        return ok("请至少提供 keywords、from_user 或 hashtag 之一");
      }

      const data = await api6551<{ list?: unknown[] }>("POST", "/open/twitter_search", body);
      const tweets = (data?.list ?? []) as Array<{
        id?: string; text?: string; createdAt?: string; userScreenName?: string;
        retweetCount?: number; favoriteCount?: number; replyCount?: number;
      }>;

      if (tweets.length === 0) return ok("未找到相关推文。");

      const lines = tweets.map((t, idx) => {
        const user = t.userScreenName ? `@${t.userScreenName}` : "";
        const time = t.createdAt ? new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
        const stats = [`❤️ ${t.favoriteCount ?? 0}`, `🔁 ${t.retweetCount ?? 0}`].join("  ");
        return `**${idx + 1}.** ${t.text ?? ""}\n${user}  ${stats}  ${time}`;
      });

      const desc = [input.keywords, input.from_user ? `@${input.from_user}` : "", input.hashtag ? `#${input.hashtag}` : ""].filter(Boolean).join(" + ");
      return ok(`🔍 "${desc}" 推文（${lines.length} 条）\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`搜索推文失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const createScheduledTaskTool = tool(
  "create_scheduled_task",
  "创建一个定时任务。任务到期时会自动启动 AI 会话执行 prompt。\n\n" +
    "scheduleType 选择规则（必须严格遵守）：\n" +
    "- once：用户说「X 分钟/小时后」「明天 X 点」「X 号 X 点」等一次性时间 → 单次执行\n" +
    "- interval：用户说「每隔 X 分钟/小时」「每 X 分钟重复」等周期性 → 间隔重复，必填 intervalValue + intervalUnit\n" +
    "- daily：用户说「每天 X 点」「每周一/三/五 X 点」→ 每日固定时间，必填 dailyTime\n\n" +
    "once 类型时间填写规则（二选一）：\n" +
    "- 相对时间（推荐）：填 delay_minutes（相对现在的分钟数），服务器自动计算准确时间。「5分钟后」→ delay_minutes=5，「2小时后」→ delay_minutes=120\n" +
    "- 绝对时间：填 scheduledTime，格式 'YYYY-MM-DDTHH:MM:SS'（本地时间，不加Z）\n\n" +
    "示例：\n" +
    "「2分钟后提醒我」→ once，delay_minutes=2\n" +
    "「每2分钟检查邮件」→ interval，intervalValue=2，intervalUnit=minutes\n" +
    "「每天早上9点汇报」→ daily，dailyTime='09:00'",
  {
    name: z.string().describe("任务名称，简短描述任务用途"),
    prompt: z.string().describe("任务执行时发送给 AI 的指令内容"),
    scheduleType: z
      .enum(["once", "interval", "daily"])
      .describe("调度类型：once=单次、interval=间隔重复、daily=每日固定时间"),
    delay_minutes: z
      .number()
      .optional()
      .describe("【once 类型专用，推荐使用】从现在起延迟执行的分钟数，服务器自动换算为准确时间。优先级高于 scheduledTime。"),
    scheduledTime: z
      .string()
      .optional()
      .describe("单次执行的本地绝对时间，格式 'YYYY-MM-DDTHH:MM:SS'（不加 Z），仅当无法用 delay_minutes 表达时才填"),
    intervalValue: z.number().optional().describe("间隔数值，scheduleType=interval 时必填"),
    intervalUnit: z
      .enum(["minutes", "hours", "days", "weeks"])
      .optional()
      .describe("间隔单位，scheduleType=interval 时必填"),
    dailyTime: z.string().optional().describe("每日执行时间，格式 HH:MM，scheduleType=daily 时必填"),
    dailyDays: z
      .array(z.number())
      .optional()
      .describe("指定星期几执行（0=周日，1=周一…6=周六），不填则每天执行，scheduleType=daily 时可选"),
    assistantId: z.string().optional().describe("指定执行任务的助理 ID（可选）"),
    cwd: z.string().optional().describe("任务执行时的工作目录（可选）"),
  },
  async (input) => {
    try {
      const scheduleType = input.scheduleType;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const refNow = Date.now();

      let scheduledTime: string | undefined;
      if (scheduleType === "once") {
        if (input.delay_minutes != null && Number(input.delay_minutes) > 0) {
          scheduledTime = new Date(refNow + Number(input.delay_minutes) * 60 * 1000).toISOString();
        } else if (input.scheduledTime) {
          const parsed = new Date(String(input.scheduledTime));
          if (isNaN(parsed.getTime())) {
            return ok(
              `创建失败：scheduledTime 格式无效（${input.scheduledTime}）。请改用 delay_minutes 指定延迟分钟数。`,
            );
          }
          if (parsed.getTime() <= refNow) {
            const nowStr = new Date(refNow).toLocaleString("zh-CN", { timeZone: tz, hour12: false });
            return ok(
              `创建失败：指定时间 ${parsed.toLocaleString("zh-CN", { timeZone: tz, hour12: false })} 已经过去（当前时间：${nowStr}）。\n请改用 delay_minutes 参数指定从现在起延迟的分钟数，例如 delay_minutes=2 表示2分钟后。`,
            );
          }
          scheduledTime = parsed.toISOString();
        } else {
          return ok(`创建失败：once 类型必须提供 delay_minutes（推荐）或 scheduledTime。`);
        }
      }

      const task = addScheduledTask({
        name: String(input.name ?? ""),
        prompt: String(input.prompt ?? ""),
        enabled: true,
        scheduleType,
        assistantId: input.assistantId,
        cwd: input.cwd ? String(input.cwd) : undefined,
        scheduledTime,
        intervalValue: input.intervalValue ? Number(input.intervalValue) : undefined,
        intervalUnit: input.intervalUnit ?? undefined,
        dailyTime: input.dailyTime ? String(input.dailyTime) : undefined,
        dailyDays: Array.isArray(input.dailyDays) ? input.dailyDays : undefined,
      });

      const nextRunStr = task.nextRun
        ? new Date(task.nextRun).toLocaleString("zh-CN", { timeZone: tz, hour12: false })
        : "未知";

      return ok(
        `定时任务已创建！\n- 名称：${task.name}\n- 类型：${task.scheduleType}\n- 下次执行：${nextRunStr}\n- 任务 ID：${task.id}`,
      );
    } catch (err) {
      return ok(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const listScheduledTasksTool = tool(
  "list_scheduled_tasks",
  "获取所有已创建的定时任务列表，返回名称、调度类型、启用状态和下次执行时间。",
  {},
  async () => {
    try {
      const tasks = loadScheduledTasks();
      if (tasks.length === 0) return ok("当前没有任何定时任务。");

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: tz, hour12: false });

      const lines = tasks.map((t) => {
        const status = t.enabled ? "✅ 启用" : "⏸ 停用";
        const nextRun = t.nextRun ? fmt(t.nextRun) : "无";
        let schedule = "";
        if (t.scheduleType === "once") schedule = `单次 @ ${t.scheduledTime ? fmt(t.scheduledTime) : "未知"}`;
        else if (t.scheduleType === "interval") schedule = `每 ${t.intervalValue} ${t.intervalUnit}`;
        else if (t.scheduleType === "daily")
          schedule = `每天 ${t.dailyTime}${t.dailyDays?.length ? `（周${t.dailyDays.join("/")}）` : ""}`;

        return `- **${t.name}** [${status}]\n  调度：${schedule}\n  下次：${nextRun}\n  ID：\`${t.id}\``;
      });

      return ok(`**定时任务列表（共 ${tasks.length} 个）**\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`获取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const deleteScheduledTaskTool = tool(
  "delete_scheduled_task",
  "删除指定 ID 的定时任务。可先用 list_scheduled_tasks 查看任务 ID。",
  {
    task_id: z.string().describe("要删除的任务 ID"),
  },
  async (input) => {
    try {
      const taskId = String(input.task_id ?? "");
      if (!taskId) return ok("任务 ID 不能为空");

      const tasks = loadScheduledTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return ok(`未找到 ID 为 ${taskId} 的任务`);

      const success = deleteScheduledTask(taskId);
      return ok(success ? `已删除定时任务：${task.name}` : `删除失败，请重试`);
    } catch (err) {
      return ok(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const webSearchTool = tool(
  "web_search",
  "通过 DuckDuckGo 搜索网络，返回 top 5 搜索结果（标题、摘要、URL）。如需查看某个结果的详细内容，再用 web_fetch 工具抓取对应 URL。",
  {
    query: z.string().describe("搜索关键词或问题"),
    max_results: z.number().optional().describe("最多返回结果数，默认 5，最大 10"),
  },
  async (input) => {
    const query = String(input.query ?? "").trim();
    if (!query) return ok("搜索词不能为空");
    const maxResults = Math.min(Number(input.max_results ?? 5), 10);
    try {
      return ok(await webSearch(query, maxResults));
    } catch (err) {
      return ok(`搜索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const webFetchTool = tool(
  "web_fetch",
  "抓取指定 URL 的内容并以纯文本返回。HTML 页面会自动清除标签，返回可读正文。可用于查看文章、文档、API 响应等。默认最多返回 8000 字符。",
  {
    url: z.string().describe("要抓取的 HTTP/HTTPS URL"),
    max_chars: z.number().optional().describe("最多返回字符数，默认 8000，最大 20000"),
  },
  async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return ok("URL 不能为空");
    const maxChars = Math.min(Number(input.max_chars ?? 8_000), 20_000);
    try {
      return ok(await webFetch(url, maxChars));
    } catch (err) {
      return ok(`抓取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const takeScreenshotTool = tool(
  "take_screenshot",
  "截取当前桌面屏幕截图。返回截图的临时文件路径，之后可用 send_file 发送给用户。",
  {},
  async () => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    const filePath = path.join(os.tmpdir(), `vk-shot-${Date.now()}.png`);

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

    if (!fs.existsSync(filePath)) {
      return { content: [{ type: "text" as const, text: "截图文件未生成" }], isError: true };
    }
    return ok(filePath);
  },
);

// ── SOP Tools (Self-Evolution) ───────────────────────────────────────────────

const saveSopTool = tool(
  "save_sop",
  "保存或更新一个标准操作流程（SOP）。当完成复杂任务后，将经过验证的操作步骤沉淀为可复用的 SOP。\n\n" +
    "SOP 应包含：前置条件、关键步骤（按顺序）、踩坑点和注意事项、验证方法。\n" +
    "命名规则：用简短的任务描述，如 '部署-nextjs-到-vercel'、'配置-eslint-prettier'。\n" +
    "只记录经过实践验证成功的流程，不要记录未验证的猜测。",
  {
    name: z.string().describe("SOP 名称，简短描述任务（用中划线连接，如 '配置-docker-compose'）"),
    content: z.string().describe("SOP 内容（Markdown 格式），包含前置条件、步骤、注意事项等"),
  },
  async (input) => {
    try {
      const name = String(input.name ?? "").trim();
      if (!name) return ok("名称不能为空");
      const content = String(input.content ?? "").trim();
      if (!content) return ok("内容不能为空");

      const existing = readSop(name);
      writeSop(name, content);

      const action = existing ? "更新" : "创建";
      return ok(`SOP ${action}成功：${name}\n大小：${content.length} 字符\n路径：~/.vk-cowork/memory/sops/${name}.md`);
    } catch (err) {
      return ok(`保存 SOP 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const listSopsTool = tool(
  "list_sops",
  "列出所有已保存的 SOP（标准操作流程），返回名称、描述、更新时间。",
  {},
  async () => {
    try {
      const sops = listSops();
      if (sops.length === 0) return ok("暂无保存的 SOP。完成复杂任务后可用 save_sop 沉淀操作流程。");

      const lines = sops.map(s =>
        `- **${s.name}**${s.description ? ` — ${s.description}` : ""}\n  更新：${s.updatedAt} | 大小：${(s.size / 1024).toFixed(1)}KB`
      );
      return ok(`**SOP 列表（共 ${sops.length} 个）**\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`列出 SOP 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const readSopTool = tool(
  "read_sop",
  "读取指定名称的 SOP 完整内容。",
  {
    name: z.string().describe("SOP 名称"),
  },
  async (input) => {
    try {
      const name = String(input.name ?? "").trim();
      if (!name) return ok("名称不能为空");

      const content = readSop(name);
      if (!content) return ok(`未找到名为 '${name}' 的 SOP。用 list_sops 查看可用列表。`);
      return ok(`# SOP: ${name}\n\n${content}`);
    } catch (err) {
      return ok(`读取 SOP 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const searchSopsTool = tool(
  "search_sops",
  "按关键词搜索相关 SOP，返回匹配度最高的结果。在执行新任务前应先搜索是否已有可复用的 SOP。",
  {
    query: z.string().describe("搜索关键词或任务描述"),
  },
  async (input) => {
    try {
      const query = String(input.query ?? "").trim();
      if (!query) return ok("搜索词不能为空");

      const results = searchSops(query);
      if (results.length === 0) return ok(`未找到与 '${query}' 相关的 SOP。`);

      const lines = results.slice(0, 5).map(s =>
        `- **${s.name}**${s.description ? ` — ${s.description}` : ""}`
      );
      return ok(`**搜索 '${query}' 的相关 SOP：**\n\n${lines.join("\n")}\n\n使用 read_sop 查看完整内容。`);
    } catch (err) {
      return ok(`搜索 SOP 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// ── Working Memory Tools (factory — uses assistantId via closure) ────────────

function createSaveWorkingMemoryTool(assistantId?: string) {
  return tool(
    "save_working_memory",
    "保存工作记忆检查点。在执行长任务时，定期保存关键上下文（当前任务、关键信息、操作历史），" +
      "确保跨会话的连续性。下次新会话会自动加载这些信息。\n\n" +
      "适合保存的内容：当前任务目标和进展、关键中间结果、重要决策、相关 SOP 名称。\n" +
      "不适合保存的内容：临时变量、完整代码、推理过程。",
    {
      key_info: z.string().describe("关键上下文信息：当前进展、重要决策、环境事实等"),
      current_task: z.string().optional().describe("当前正在执行的任务描述"),
      related_sops: z.array(z.string()).optional().describe("相关的 SOP 名称列表"),
      history: z.array(z.string()).optional().describe("最近的操作历史摘要（每条一句话）"),
    },
    async (input) => {
      try {
        const keyInfo = String(input.key_info ?? "").trim();
        if (!keyInfo) return ok("key_info 不能为空");

        const checkpoint = {
          keyInfo,
          currentTask: input.current_task ? String(input.current_task) : undefined,
          relatedSops: input.related_sops as string[] | undefined,
          history: input.history as string[] | undefined,
        };

        if (assistantId) {
          new ScopedMemory(assistantId).writeWorkingMemory(checkpoint);
        } else {
          writeWorkingMemory(checkpoint);
        }

        return ok(`工作记忆已保存。内容将在下次会话中自动加载。\n- 关键信息：${keyInfo.slice(0, 100)}...`);
      } catch (err) {
        return ok(`保存工作记忆失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

function createReadWorkingMemoryTool(assistantId?: string) {
  return tool(
    "read_working_memory",
    "读取当前的工作记忆检查点，查看上次保存的任务上下文和进展。",
    {},
    async () => {
      try {
        const content = assistantId
          ? new ScopedMemory(assistantId).readWorkingMemory()
          : readWorkingMemory();
        if (!content?.trim()) return ok("暂无保存的工作记忆。");
        return ok(content);
      } catch (err) {
        return ok(`读取工作记忆失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ── Memory Distillation ─────────────────────────────────────────────────────

const distillMemoryTool = tool(
  "distill_memory",
  "任务完成后调用此工具，触发结构化记忆蒸馏。系统会引导你提取本次任务中值得长期保留的信息。\n" +
    "适合时机：完成复杂任务后、发现重要环境事实后、踩坑并找到解决方案后。",
  {},
  async () => {
    const managementSop = readSop("memory-management");
    const sopSection = managementSop
      ? `\n以下是你的记忆管理 SOP，请严格遵循：\n${managementSop}\n`
      : "";

    return ok(
      `[记忆蒸馏启动]${sopSection}\n` +
      `请回顾本次任务，按以下规则提取信息：\n\n` +
      `1. **环境事实**（路径/凭证/配置）→ 写入 MEMORY.md，标注 [P1|expire:90天后日期]\n` +
      `2. **用户偏好/决策** → 写入 MEMORY.md，标注 [P0]\n` +
      `3. **复杂任务流程**（多步骤、有踩坑点）→ 用 save_sop 保存\n` +
      `4. **本次会话摘要** → 追加到 daily/今日.md\n` +
      `5. **未完成任务/下次需继续的上下文** → 用 save_working_memory 保存\n\n` +
      `━━ 禁止记忆 ━━\n` +
      `- 临时变量、具体推理过程\n` +
      `- 未经验证的猜测\n` +
      `- 通用常识（你本来就知道的）\n` +
      `- 可以轻松复现的细节\n\n` +
      `请立即执行上述操作，完成后无需报告。`
    );
  },
);

// ── Atomic Power Tools (inspired by GenericAgent) ───────────────────────────

function createRunScriptTool(sessionCwd?: string) {
  return tool(
  "run_script",
  "执行脚本代码（Python / PowerShell / Node.js），支持超时控制。\n\n" +
    "适合场景：安装依赖、数据处理、系统操作、调用 API、运行复杂脚本。\n" +
    "与 Bash 工具的区别：支持多行脚本、超时保护、丰富的输出格式化。\n\n" +
    "注意：Python 脚本会保存为临时文件执行（文件模式），PowerShell/Node 直接执行。",
  {
    code: z.string().describe("要执行的代码"),
    language: z.enum(["python", "powershell", "node"]).describe("脚本语言"),
    timeout: z.number().optional().describe("超时秒数，默认 60 秒，最大 300 秒"),
    cwd: z.string().optional().describe("工作目录（可选）"),
  },
  async (input) => {
    const { exec, spawn } = await import("child_process");
    const { promisify } = await import("util");
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    const code = String(input.code ?? "").trim();
    if (!code) return ok("代码不能为空");

    const language = input.language ?? "python";
    const timeout = Math.min(Number(input.timeout ?? 60), 300) * 1000;
    const cwd = input.cwd ? String(input.cwd) : (sessionCwd || os.homedir());

    let cmd: string[];
    let tmpFile: string | null = null;

    if (language === "python") {
      tmpFile = path.join(os.tmpdir(), `vk-script-${Date.now()}.py`);
      fs.writeFileSync(tmpFile, code, "utf8");
      const pythonCmd = process.platform === "win32" ? "python" : "python3";
      cmd = [pythonCmd, "-X", "utf8", "-u", tmpFile];
    } else if (language === "powershell") {
      if (process.platform === "win32") {
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", code];
      } else {
        cmd = ["pwsh", "-NoProfile", "-NonInteractive", "-Command", code];
      }
    } else {
      cmd = ["node", "-e", code];
    }

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
          cwd,
          timeout,
          shell: false,
          windowsHide: true,
          env: process.env,
        });

        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

        proc.on("close", (exitCode) => {
          resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
        });

        proc.on("error", (err) => {
          resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: -1 });
        });
      });

      const maxLen = 8000;
      let output = result.stdout;
      if (result.stderr) output += (output ? "\n" : "") + `[STDERR]\n${result.stderr}`;
      if (output.length > maxLen) {
        output = output.slice(0, maxLen / 2) + "\n...[truncated]...\n" + output.slice(-maxLen / 2);
      }

      const status = result.exitCode === 0 ? "✅" : "❌";
      return ok(`${status} Exit code: ${result.exitCode}\n\n${output || "(no output)"}`);
    } catch (err) {
      return ok(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }
  },
);
}

const desktopControlTool = tool(
  "desktop_control",
  "发送键盘输入或执行桌面自动化操作。\n\n" +
    "支持的操作类型：\n" +
    "- type: 输入文字\n" +
    "- key: 按下特定按键（如 Enter, Tab, Escape, ctrl+c, alt+f4）\n" +
    "- mouse_click: 在指定坐标点击（x, y）\n" +
    "- mouse_move: 移动鼠标到指定坐标\n\n" +
    "注意：操作直接作用于桌面，请确认目标窗口已获得焦点。",
  {
    action: z.enum(["type", "key", "mouse_click", "mouse_move"]).describe("操作类型"),
    text: z.string().optional().describe("要输入的文字（action=type 时必填）"),
    key: z.string().optional().describe("按键名（action=key 时必填，如 'Enter', 'Tab', 'ctrl+c', 'alt+f4'）"),
    x: z.number().optional().describe("鼠标 X 坐标（mouse 操作时必填）"),
    y: z.number().optional().describe("鼠标 Y 坐标（mouse 操作时必填）"),
    button: z.enum(["left", "right", "middle"]).optional().describe("鼠标按钮，默认 left"),
  },
  async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const action = input.action;
    const platform = process.platform;

    try {
      if (platform === "win32") {
        return ok(await desktopControlWindows(execAsync, action, input));
      } else if (platform === "darwin") {
        return ok(await desktopControlMac(execAsync, action, input));
      } else {
        return ok(await desktopControlLinux(execAsync, action, input));
      }
    } catch (err) {
      return ok(`桌面操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

async function desktopControlWindows(
  execAsync: ExecFn,
  action: string,
  input: { text?: string; key?: string; x?: number; y?: number; button?: string },
): Promise<string> {
  if (action === "type" && input.text) {
    const escaped = input.text.replace(/'/g, "''");
    await execAsync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`,
    );
    return `已输入文字: ${input.text.slice(0, 50)}`;
  }

  if (action === "key" && input.key) {
    const keyMap: Record<string, string> = {
      enter: "{ENTER}", tab: "{TAB}", escape: "{ESC}", backspace: "{BS}",
      delete: "{DEL}", up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
      home: "{HOME}", end: "{END}", "page_up": "{PGUP}", "page_down": "{PGDN}",
      f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}",
      space: " ",
    };
    let sendKey = input.key.toLowerCase();

    if (sendKey.includes("+")) {
      const parts = sendKey.split("+");
      const modifiers = parts.slice(0, -1);
      const baseKey = parts[parts.length - 1];
      let prefix = "";
      for (const m of modifiers) {
        if (m === "ctrl") prefix += "^";
        else if (m === "alt") prefix += "%";
        else if (m === "shift") prefix += "+";
      }
      sendKey = prefix + (keyMap[baseKey] ?? baseKey);
    } else {
      sendKey = keyMap[sendKey] ?? sendKey;
    }

    const escaped = sendKey.replace(/'/g, "''");
    await execAsync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`,
    );
    return `已按下: ${input.key}`;
  }

  if (action === "mouse_click" && input.x != null && input.y != null) {
    const btn = input.button === "right" ? 2 : 0;
    await execAsync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; ` +
        `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${input.x},${input.y}); ` +
        `Add-Type @'
using System; using System.Runtime.InteropServices;
public class MouseOp { [DllImport(\\"user32.dll\\")] public static extern void mouse_event(int f,int dx,int dy,int d,int e); }
'@; ` +
        `[MouseOp]::mouse_event(${btn === 0 ? "0x0002,0,0,0,0); [MouseOp]::mouse_event(0x0004" : "0x0008,0,0,0,0); [MouseOp]::mouse_event(0x0010"},0,0,0,0)"`,
    );
    return `已点击 (${input.x}, ${input.y}) [${input.button ?? "left"}]`;
  }

  if (action === "mouse_move" && input.x != null && input.y != null) {
    await execAsync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; ` +
        `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${input.x},${input.y})"`,
    );
    return `鼠标已移动到 (${input.x}, ${input.y})`;
  }

  return "无效操作，请检查参数";
}

async function desktopControlMac(
  execAsync: ExecFn,
  action: string,
  input: { text?: string; key?: string; x?: number; y?: number; button?: string },
): Promise<string> {
  if (action === "type" && input.text) {
    const escaped = input.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await execAsync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
    return `已输入文字: ${input.text.slice(0, 50)}`;
  }

  if (action === "key" && input.key) {
    const keyMap: Record<string, number> = {
      enter: 36, tab: 48, escape: 53, backspace: 51, delete: 117,
      up: 126, down: 125, left: 123, right: 124, space: 49,
      home: 115, end: 119,
    };
    let keyLower = input.key.toLowerCase();
    const parts = keyLower.split("+");

    if (parts.length > 1) {
      const modifiers = parts.slice(0, -1);
      const baseKey = parts[parts.length - 1];
      const modStr = modifiers.map(m => {
        if (m === "ctrl") return "control down";
        if (m === "alt" || m === "option") return "option down";
        if (m === "shift") return "shift down";
        if (m === "cmd" || m === "command") return "command down";
        return "";
      }).filter(Boolean).join(", ");

      const code = keyMap[baseKey];
      if (code !== undefined) {
        await execAsync(`osascript -e 'tell application "System Events" to key code ${code} using {${modStr}}'`);
      } else {
        await execAsync(`osascript -e 'tell application "System Events" to keystroke "${baseKey}" using {${modStr}}'`);
      }
    } else {
      const code = keyMap[keyLower];
      if (code !== undefined) {
        await execAsync(`osascript -e 'tell application "System Events" to key code ${code}'`);
      } else {
        await execAsync(`osascript -e 'tell application "System Events" to keystroke "${keyLower}"'`);
      }
    }
    return `已按下: ${input.key}`;
  }

  if ((action === "mouse_click" || action === "mouse_move") && input.x != null && input.y != null) {
    if (action === "mouse_click") {
      await execAsync(
        `osascript -e 'tell application "System Events" to click at {${input.x}, ${input.y}}'`,
      );
      return `已点击 (${input.x}, ${input.y})`;
    }
    return "macOS 不支持 osascript 移动鼠标，建议安装 cliclick";
  }

  return "无效操作，请检查参数";
}

async function desktopControlLinux(
  execAsync: ExecFn,
  action: string,
  input: { text?: string; key?: string; x?: number; y?: number; button?: string },
): Promise<string> {
  if (action === "type" && input.text) {
    const escaped = input.text.replace(/'/g, "'\\''");
    await execAsync(`xdotool type -- '${escaped}'`);
    return `已输入文字: ${input.text.slice(0, 50)}`;
  }

  if (action === "key" && input.key) {
    const keyStr = input.key.replace(/\+/g, "+");
    await execAsync(`xdotool key -- ${keyStr}`);
    return `已按下: ${input.key}`;
  }

  if (action === "mouse_click" && input.x != null && input.y != null) {
    const btn = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
    await execAsync(`xdotool mousemove ${input.x} ${input.y} click ${btn}`);
    return `已点击 (${input.x}, ${input.y}) [${input.button ?? "left"}]`;
  }

  if (action === "mouse_move" && input.x != null && input.y != null) {
    await execAsync(`xdotool mousemove ${input.x} ${input.y}`);
    return `鼠标已移动到 (${input.x}, ${input.y})`;
  }

  return "无效操作，请检查参数。Linux 需要安装 xdotool: sudo apt install xdotool";
}

const screenAnalyzeTool = tool(
  "screen_analyze",
  "截取桌面屏幕截图并返回文件路径和基本信息。\n" +
    "比 take_screenshot 更强大：支持指定区域截图、自动记录截图时的活动窗口信息。\n" +
    "截图保存为临时文件，可用于后续分析或发送给用户。",
  {
    region: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }).optional().describe("截取区域（可选，不填则截全屏）"),
    description: z.string().optional().describe("截图目的描述（用于记录）"),
  },
  async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    const filePath = path.join(os.tmpdir(), `vk-screen-${Date.now()}.png`);
    const platform = process.platform;

    try {
      let activeWindow = "unknown";

      if (platform === "darwin") {
        try {
          const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`);
          activeWindow = stdout.trim();
        } catch { /* ignore */ }

        if (input.region) {
          const r = input.region;
          await execAsync(`screencapture -R${r.x},${r.y},${r.width},${r.height} -x "${filePath}"`);
        } else {
          await execAsync(`screencapture -x "${filePath}"`);
        }
      } else if (platform === "win32") {
        try {
          const { stdout } = await execAsync(
            `powershell -Command "(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object CPU -Descending | Select-Object -First 1).MainWindowTitle"`,
          );
          activeWindow = stdout.trim();
        } catch { /* ignore */ }

        if (input.region) {
          const r = input.region;
          await execAsync(
            `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
              `$b=New-Object System.Drawing.Bitmap(${r.width},${r.height}); ` +
              `$g=[System.Drawing.Graphics]::FromImage($b); ` +
              `$g.CopyFromScreen(${r.x},${r.y},0,0,[System.Drawing.Size]::new(${r.width},${r.height})); ` +
              `$b.Save('${filePath}')"`,
          );
        } else {
          await execAsync(
            `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
              `$b=New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); ` +
              `$g=[System.Drawing.Graphics]::FromImage($b); ` +
              `$g.CopyFromScreen(0,0,0,0,$b.Size); ` +
              `$b.Save('${filePath}')"`,
          );
        }
      } else {
        try {
          const { stdout } = await execAsync(`xdotool getactivewindow getwindowname`);
          activeWindow = stdout.trim();
        } catch { /* ignore */ }

        if (input.region) {
          const r = input.region;
          await execAsync(`gnome-screenshot -a -f "${filePath}" 2>/dev/null || scrot -a ${r.x},${r.y},${r.width},${r.height} "${filePath}"`);
        } else {
          await execAsync(`gnome-screenshot -f "${filePath}" 2>/dev/null || scrot "${filePath}"`);
        }
      }

      if (!fs.existsSync(filePath)) {
        return { content: [{ type: "text" as const, text: "截图文件未生成" }], isError: true };
      }

      const stat = fs.statSync(filePath);
      const info: string[] = [
        `截图已保存: ${filePath}`,
        `文件大小: ${(stat.size / 1024).toFixed(1)}KB`,
        `活动窗口: ${activeWindow}`,
        `时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      ];
      if (input.region) {
        info.push(`区域: (${input.region.x},${input.region.y}) ${input.region.width}x${input.region.height}`);
      }
      if (input.description) {
        info.push(`用途: ${input.description}`);
      }

      return ok(info.join("\n"));
    } catch (err) {
      return ok(`截图失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const processControlTool = tool(
  "process_control",
  "管理系统进程：列出进程、终止进程、检查端口占用。\n\n" +
    "适合场景：排查端口冲突、关闭僵尸进程、查看资源占用。",
  {
    action: z.enum(["list", "kill", "find_by_port"]).describe("操作类型"),
    pid: z.number().optional().describe("进程 PID（action=kill 时必填）"),
    port: z.number().optional().describe("端口号（action=find_by_port 时必填）"),
    filter: z.string().optional().describe("进程名过滤（action=list 时可选）"),
  },
  async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const platform = process.platform;

    try {
      if (input.action === "list") {
        const filter = input.filter ? String(input.filter) : "";
        let cmd: string;
        if (platform === "win32") {
          cmd = filter
            ? `tasklist /FI "IMAGENAME eq *${filter}*" /FO CSV /NH`
            : `powershell -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Id,ProcessName,CPU,WorkingSet | Format-Table -AutoSize"`;
        } else {
          cmd = filter
            ? `ps aux | grep -i "${filter}" | head -20`
            : `ps aux --sort=-%cpu | head -20`;
        }
        const { stdout } = await execAsync(cmd);
        return ok(stdout || "无结果");
      }

      if (input.action === "kill" && input.pid != null) {
        if (platform === "win32") {
          await execAsync(`taskkill /PID ${input.pid} /F`);
        } else {
          await execAsync(`kill -9 ${input.pid}`);
        }
        return ok(`进程 ${input.pid} 已终止`);
      }

      if (input.action === "find_by_port" && input.port != null) {
        let cmd: string;
        if (platform === "win32") {
          cmd = `netstat -ano | findstr :${input.port}`;
        } else {
          cmd = `lsof -i :${input.port} 2>/dev/null || netstat -tlnp 2>/dev/null | grep :${input.port}`;
        }
        const { stdout } = await execAsync(cmd);
        return ok(stdout || `端口 ${input.port} 未被占用`);
      }

      return ok("无效操作，请检查参数");
    } catch (err) {
      return ok(`进程操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const clipboardTool = tool(
  "clipboard",
  "读取或写入系统剪贴板内容。\n\n" +
    "适合场景：获取用户复制的内容、将结果放入剪贴板方便粘贴。",
  {
    action: z.enum(["read", "write"]).describe("操作类型"),
    content: z.string().optional().describe("要写入剪贴板的内容（action=write 时必填）"),
  },
  async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const platform = process.platform;

    try {
      if (input.action === "read") {
        let cmd: string;
        if (platform === "win32") {
          cmd = `powershell -Command "Get-Clipboard"`;
        } else if (platform === "darwin") {
          cmd = "pbpaste";
        } else {
          cmd = "xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output";
        }
        const { stdout } = await execAsync(cmd);
        return ok(stdout || "(剪贴板为空)");
      }

      if (input.action === "write" && input.content) {
        const content = input.content;
        if (platform === "win32") {
          const escaped = content.replace(/'/g, "''");
          await execAsync(`powershell -Command "Set-Clipboard -Value '${escaped}'"`);
        } else if (platform === "darwin") {
          const escaped = content.replace(/'/g, "'\\''");
          await execAsync(`echo '${escaped}' | pbcopy`);
        } else {
          const escaped = content.replace(/'/g, "'\\''");
          await execAsync(`echo '${escaped}' | xclip -selection clipboard 2>/dev/null || echo '${escaped}' | xsel --clipboard --input`);
        }
        return ok(`已写入剪贴板: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
      }

      return ok("无效操作，请检查参数");
    } catch (err) {
      return ok(`剪贴板操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const systemInfoTool = tool(
  "system_info",
  "获取系统环境信息：OS 版本、CPU/内存使用、磁盘空间、网络接口、已安装的工具版本。\n" +
    "适合场景：环境检查、排障、了解当前系统状态。",
  {
    category: z.enum(["overview", "disk", "network", "tools"]).optional().describe("信息类别，默认 overview"),
  },
  async (input) => {
    const os = await import("os");
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const category = input.category ?? "overview";

    try {
      if (category === "overview") {
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const info = [
          `平台: ${os.platform()} ${os.arch()} ${os.release()}`,
          `主机名: ${os.hostname()}`,
          `CPU: ${cpus[0]?.model ?? "unknown"} (${cpus.length} cores)`,
          `内存: ${(freeMem / 1024 / 1024 / 1024).toFixed(1)}GB 可用 / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)}GB 总计`,
          `运行时间: ${(os.uptime() / 3600).toFixed(1)} 小时`,
        ];
        return ok(info.join("\n"));
      }

      if (category === "disk") {
        let cmd: string;
        if (process.platform === "win32") {
          cmd = `powershell -Command "Get-PSDrive -PSProvider FileSystem | Format-Table Name,Used,Free,@{Name='Size(GB)';Expression={[math]::Round(($_.Used+$_.Free)/1GB,1)}} -AutoSize"`;
        } else {
          cmd = "df -h";
        }
        const { stdout } = await execAsync(cmd);
        return ok(stdout);
      }

      if (category === "network") {
        const interfaces = os.networkInterfaces();
        const lines: string[] = [];
        for (const [name, addrs] of Object.entries(interfaces)) {
          if (!addrs) continue;
          for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal) {
              lines.push(`${name}: ${addr.address}`);
            }
          }
        }
        return ok(lines.length ? lines.join("\n") : "无活动网络接口");
      }

      if (category === "tools") {
        const checks = [
          { name: "Node.js", cmd: "node --version" },
          { name: "npm", cmd: "npm --version" },
          { name: "Python", cmd: process.platform === "win32" ? "python --version" : "python3 --version" },
          { name: "pip", cmd: process.platform === "win32" ? "pip --version" : "pip3 --version" },
          { name: "Git", cmd: "git --version" },
          { name: "Docker", cmd: "docker --version" },
        ];
        const results: string[] = [];
        for (const check of checks) {
          try {
            const { stdout } = await execAsync(check.cmd);
            results.push(`${check.name}: ${stdout.trim()}`);
          } catch {
            results.push(`${check.name}: 未安装`);
          }
        }
        return ok(results.join("\n"));
      }

      return ok("未知类别");
    } catch (err) {
      return ok(`获取系统信息失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a shared MCP server instance for a Claude agent session.
 * When assistantId is provided, working memory tools are scoped to
 * that assistant's private directory. SOP tools remain shared.
 * When sessionCwd is provided, run_script defaults to that directory.
 */
export function createSharedMcpServer(opts?: { assistantId?: string; sessionCwd?: string }) {
  const assistantId = opts?.assistantId;
  const sessionCwd = opts?.sessionCwd;
  return createSdkMcpServer({
    name: "vk-shared",
    version: "2.0.0",
    tools: [
      // Scheduler
      createScheduledTaskTool,
      listScheduledTasksTool,
      deleteScheduledTaskTool,
      // Web
      webSearchTool,
      webFetchTool,
      // Screen & Desktop
      takeScreenshotTool,
      screenAnalyzeTool,
      desktopControlTool,
      // SOP (self-evolution — shared across all assistants)
      saveSopTool,
      listSopsTool,
      readSopTool,
      searchSopsTool,
      // Working Memory (scoped to assistant if ID provided)
      createSaveWorkingMemoryTool(assistantId),
      createReadWorkingMemoryTool(assistantId),
      // Memory Distillation
      distillMemoryTool,
      // Atomic Power Tools
      createRunScriptTool(sessionCwd),
      processControlTool,
      clipboardTool,
      systemInfoTool,
      // 6551 OpenNews — crypto/financial news with AI ratings
      newsLatestTool,
      newsSearchTool,
      // 6551 OpenTwitter — Twitter/X data
      twitterUserTweetsTool,
      twitterSearchTool,
    ],
  });
}
