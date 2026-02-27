/**
 * Shared MCP server for all agent contexts (main window, DingTalk, Feishu).
 * Exposes common tools: scheduler, web_search, web_fetch, take_screenshot.
 *
 * Claude provider: injected via mcpServers option in query().
 * Codex provider: tools are accessible via bash directly (no MCP needed).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  addScheduledTask,
  loadScheduledTasks,
  deleteScheduledTask,
} from "./scheduler.js";

// ── Helpers ────────────────────────────────────────────────────────────────

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

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a shared MCP server instance for a Claude agent session.
 * Each call returns a fresh McpSdkServerConfigWithInstance.
 */
export function createSharedMcpServer() {
  return createSdkMcpServer({
    name: "vk-shared",
    version: "1.0.0",
    tools: [
      createScheduledTaskTool,
      listScheduledTasksTool,
      deleteScheduledTaskTool,
      webSearchTool,
      webFetchTool,
      takeScreenshotTool,
    ],
  });
}
