import type { ClientEvent } from "../types.js";
import { loadAssistantsConfig, type AssistantConfig } from "./assistants-config.js";

type SessionRunner = (event: ClientEvent) => Promise<void>;

const lastHeartbeatRun = new Map<string, number>();
let heartbeatTimer: NodeJS.Timeout | null = null;
let memoryCompactTimer: NodeJS.Timeout | null = null;

function buildHeartbeatPrompt(assistant: AssistantConfig): string {
  const sections: string[] = [];
  if (assistant.heartbeatRules?.trim()) {
    sections.push(`## 心跳行为规则\n${assistant.heartbeatRules.trim()}`);
  }
  sections.push("请根据以上规则执行心跳巡检。如果没有需要汇报的事项，请直接输出 <no-action>。");
  return sections.join("\n\n");
}

export function startHeartbeatLoop(runner: SessionRunner): void {
  if (heartbeatTimer) return;

  console.log("[Heartbeat] Starting heartbeat loop...");

  heartbeatTimer = setInterval(() => {
    const { assistants } = loadAssistantsConfig();
    const now = Date.now();

    for (const a of assistants) {
      const interval = (a.heartbeatInterval ?? 30) * 60_000;
      const last = lastHeartbeatRun.get(a.id) ?? 0;
      if (now - last < interval) continue;

      lastHeartbeatRun.set(a.id, now);
      runAssistantHeartbeat(a, runner);
    }
  }, 60_000);
}

export function stopHeartbeatLoop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log("[Heartbeat] Heartbeat loop stopped");
  }
}

function runAssistantHeartbeat(assistant: AssistantConfig, runner: SessionRunner): void {
  const prompt = buildHeartbeatPrompt(assistant);
  console.log(`[Heartbeat] Running heartbeat for assistant: ${assistant.name}`);

  runner({
    type: "session.start",
    payload: {
      title: `[心跳] ${assistant.name}`,
      prompt,
      cwd: assistant.defaultCwd,
      assistantId: assistant.id,
      assistantSkillNames: assistant.skillNames ?? [],
      provider: assistant.provider,
      model: assistant.model,
      background: true,
    },
  }).catch((e) => console.error(`[Heartbeat] Failed for "${assistant.name}":`, e));
}

export function startMemoryCompactTimer(runner: SessionRunner): void {
  if (memoryCompactTimer) return;

  console.log("[Heartbeat] Starting memory compaction timer (weekly Mon 03:00)...");

  const checkCompaction = () => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() === 3 && now.getMinutes() === 0) {
      const config = loadAssistantsConfig();
      const assistant = config.assistants.find((a) => a.id === config.defaultAssistantId) ?? config.assistants[0];
      if (!assistant) return;

      const prompt = `请执行每周记忆压缩任务：
1. 读取 ~/.vk-cowork/memory/daily/ 目录下最近 7 天的日志文件（L2）
2. 将本周的关键事件、决策、和洞察提炼，追加到 ~/.vk-cowork/memory/insights/${now.toISOString().slice(0, 7)}.md（L1）
3. 更新 ~/.vk-cowork/memory/insights/.abstract 索引
完成后汇报压缩了哪些内容。`;

      console.log("[Heartbeat] Running weekly memory compaction...");
      runner({
        type: "session.start",
        payload: {
          title: "[记忆压缩] L2→L1",
          prompt,
          cwd: assistant.defaultCwd,
          assistantId: assistant.id,
          assistantSkillNames: assistant.skillNames ?? [],
          provider: assistant.provider,
          model: assistant.model,
          background: true,
        },
      }).catch((e) => console.error("[Heartbeat] Memory compaction failed:", e));
    }
  };

  memoryCompactTimer = setInterval(checkCompaction, 60_000);
}

export function stopMemoryCompactTimer(): void {
  if (memoryCompactTimer) {
    clearInterval(memoryCompactTimer);
    memoryCompactTimer = null;
  }
}
