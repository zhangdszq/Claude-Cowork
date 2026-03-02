import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { app } from "electron";
import type { ClientEvent } from "../types.js";
import { loadAssistantsConfig } from "./assistants-config.js";

// ─── Types ────────────────────────────────────────────────────
export interface GoalProgressEntry {
  sessionId: string;
  runAt: string;
  summary: string;
  isComplete: boolean;
  nextSteps?: string;
}

export interface LongTermGoal {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused" | "completed" | "abandoned";
  assistantId?: string;
  cwd?: string;
  retryInterval: number;
  maxRuns: number;
  totalRuns: number;
  progressLog: GoalProgressEntry[];
  nextRunAt?: string;          // persisted so we can resume after restart
  consecutiveErrors?: number;  // reset on success, auto-pause at threshold
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface GoalsState {
  goals: LongTermGoal[];
}

// ─── Constants ────────────────────────────────────────────────
const PROMPT_HISTORY_LIMIT = 8;  // max entries shown in prompt
const MAX_CONSECUTIVE_ERRORS = 3; // auto-pause threshold

// ─── SessionRunner injection ───────────────────────────────────
type SessionRunner = (event: ClientEvent) => Promise<void>;
let sessionRunner: SessionRunner | null = null;

export function setGoalsSessionRunner(fn: SessionRunner): void {
  sessionRunner = fn;
}

// ─── Storage ──────────────────────────────────────────────────
const GOALS_FILE = join(app.getPath("userData"), "long-term-goals.json");

function ensureDirectory(): void {
  const dir = dirname(GOALS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadGoals(): LongTermGoal[] {
  try {
    if (!existsSync(GOALS_FILE)) return [];
    const raw = readFileSync(GOALS_FILE, "utf8");
    const state = JSON.parse(raw) as GoalsState;
    return state.goals ?? [];
  } catch (err) {
    console.error("[Goals] Failed to load goals:", err);
    return [];
  }
}

function saveGoals(goals: LongTermGoal[]): void {
  ensureDirectory();
  const state: GoalsState = { goals };
  writeFileSync(GOALS_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ─── CRUD ─────────────────────────────────────────────────────
export function addGoal(
  input: Omit<LongTermGoal, "id" | "status" | "totalRuns" | "progressLog" | "createdAt" | "updatedAt" | "completedAt" | "nextRunAt" | "consecutiveErrors">
): LongTermGoal {
  const goals = loadGoals();
  const now = new Date().toISOString();
  const goal: LongTermGoal = {
    ...input,
    id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    status: "active",
    totalRuns: 0,
    progressLog: [],
    consecutiveErrors: 0,
    createdAt: now,
    updatedAt: now,
  };
  goals.push(goal);
  saveGoals(goals);
  return goal;
}

export function updateGoal(id: string, updates: Partial<LongTermGoal>): LongTermGoal | null {
  const goals = loadGoals();
  const idx = goals.findIndex((g) => g.id === id);
  if (idx === -1) return null;
  goals[idx] = { ...goals[idx], ...updates, updatedAt: new Date().toISOString() };
  saveGoals(goals);
  return goals[idx];
}

export function deleteGoal(id: string): boolean {
  const goals = loadGoals();
  const idx = goals.findIndex((g) => g.id === id);
  if (idx === -1) return false;
  // Cancel any pending timer
  const timer = pendingRunTimers.get(id);
  if (timer) { clearTimeout(timer); pendingRunTimers.delete(id); }
  goals.splice(idx, 1);
  saveGoals(goals);
  return true;
}

export function getGoal(id: string): LongTermGoal | null {
  return loadGoals().find((g) => g.id === id) ?? null;
}

// ─── Prompt generation ────────────────────────────────────────
export function buildGoalPrompt(goal: LongTermGoal): string {
  const lines: string[] = [];
  lines.push(`【长期目标】${goal.name}`);
  lines.push("");
  lines.push("目标描述：");
  lines.push(goal.description);
  lines.push("");

  const log = goal.progressLog;
  if (log.length > 0) {
    // Only show the most recent entries to avoid token overflow
    const shown = log.slice(-PROMPT_HISTORY_LIMIT);
    const skipped = log.length - shown.length;
    lines.push(`已完成进度（共 ${log.length} 次运行${skipped > 0 ? `，仅展示最近 ${PROMPT_HISTORY_LIMIT} 次` : ""}）：`);
    shown.forEach((entry, i) => {
      const absIndex = skipped + i + 1;
      lines.push(`第 ${absIndex} 次（${new Date(entry.runAt).toLocaleString("zh-CN")}）：${entry.summary}`);
      if (entry.nextSteps) lines.push(`  → 计划：${entry.nextSteps}`);
    });
    lines.push("");
  }

  lines.push("当前任务：继续推进上述目标，完成尽可能多的工作。");
  lines.push("");
  lines.push("完成后，请在回复末尾附上以下标签（不要省略）：");
  lines.push("<goal-complete>true 或 false</goal-complete>");
  lines.push("<goal-progress>本次完成的工作摘要（一两句话）</goal-progress>");
  lines.push("<goal-next-steps>下一步计划（如未完成）</goal-next-steps>");

  return lines.join("\n");
}

// ─── Parse AI output ──────────────────────────────────────────
export interface GoalOutputParsed {
  isComplete: boolean;
  summary: string;
  nextSteps?: string;
}

export function parseGoalOutput(text: string): GoalOutputParsed {
  const completeMatch = text.match(/<goal-complete>\s*(true|false)\s*<\/goal-complete>/i);
  const progressMatch = text.match(/<goal-progress>([\s\S]*?)<\/goal-progress>/i);
  const nextStepsMatch = text.match(/<goal-next-steps>([\s\S]*?)<\/goal-next-steps>/i);

  const isComplete = completeMatch ? completeMatch[1].trim().toLowerCase() === "true" : false;
  const summary = progressMatch ? progressMatch[1].trim() : text.slice(-200).trim();
  const nextSteps = nextStepsMatch ? nextStepsMatch[1].trim() : undefined;

  return { isComplete, summary, nextSteps };
}

// ─── Timer registry (prevents duplicate schedules) ────────────
const pendingRunTimers = new Map<string, NodeJS.Timeout>();

function scheduleNextRun(goal: LongTermGoal, delayMs: number): void {
  // Cancel any existing timer for this goal
  const existing = pendingRunTimers.get(goal.id);
  if (existing) clearTimeout(existing);

  // Persist the scheduled time so we can recover after restart
  const nextRunAt = new Date(Date.now() + delayMs).toISOString();
  updateGoal(goal.id, { nextRunAt });

  const timer = setTimeout(() => {
    pendingRunTimers.delete(goal.id);
    const latest = getGoal(goal.id);
    if (latest && latest.status === "active") {
      triggerGoalRun(latest);
    }
  }, delayMs);

  pendingRunTimers.set(goal.id, timer);
  console.log(`[Goals] Goal "${goal.name}" next run scheduled at ${nextRunAt}`);
}

// ─── Trigger a goal run ───────────────────────────────────────
export function triggerGoalRun(goal: LongTermGoal): void {
  if (!sessionRunner) {
    console.warn(`[Goals] sessionRunner not set, cannot run goal: ${goal.name}`);
    return;
  }

  // Double-check status before firing — race condition guard
  const fresh = getGoal(goal.id);
  if (!fresh || fresh.status !== "active") {
    console.log(`[Goals] Skipping run for "${goal.name}" — status is "${fresh?.status ?? "deleted"}"`);
    return;
  }

  const config = loadAssistantsConfig();
  const assistant = fresh.assistantId
    ? config.assistants.find((a) => a.id === fresh.assistantId)
    : config.assistants.find((a) => a.id === config.defaultAssistantId) ?? config.assistants[0];

  const runNumber = fresh.totalRuns + 1;
  const title = `[目标] ${fresh.name} - 第${runNumber}次`;

  sessionRunner({
    type: "session.start",
    payload: {
      title,
      prompt: buildGoalPrompt(fresh),
      cwd: fresh.cwd || assistant?.defaultCwd,
      assistantId: assistant?.id,
      assistantSkillNames: assistant?.skillNames ?? [],
      assistantPersona: assistant?.persona,
      provider: assistant?.provider ?? "claude",
      model: assistant?.model,
    },
  }).catch((e) => console.error(`[Goals] Failed to start session for goal "${fresh.name}":`, e));

  // Clear nextRunAt since we're now running; increment totalRuns
  updateGoal(fresh.id, { totalRuns: runNumber, nextRunAt: undefined });
}

// ─── Handle session completion ────────────────────────────────
export function onGoalSessionComplete(
  sessionTitle: string,
  sessionId: string,
  lastMessageText: string,
  sessionStatus: string
): void {
  // Extract goal name from title pattern: "[目标] <name> - 第N次"
  const match = sessionTitle.match(/^\[目标\]\s+(.+?)\s+-\s+第\d+次$/);
  if (!match) return;

  const goalName = match[1];
  const goals = loadGoals();
  const goal = goals.find((g) => g.name === goalName && (g.status === "active" || g.status === "paused"));
  if (!goal) return;

  const parsed = parseGoalOutput(lastMessageText);

  const entry: GoalProgressEntry = {
    sessionId,
    runAt: new Date().toISOString(),
    summary: parsed.summary || (sessionStatus === "error" ? "运行出错" : "（无摘要）"),
    isComplete: parsed.isComplete,
    nextSteps: parsed.nextSteps,
  };

  const updatedLog = [...goal.progressLog, entry];

  // ── Goal completed ──
  if (parsed.isComplete) {
    updateGoal(goal.id, {
      status: "completed",
      progressLog: updatedLog,
      consecutiveErrors: 0,
      completedAt: new Date().toISOString(),
    });
    console.log(`[Goals] Goal "${goal.name}" marked as completed.`);
    notifyGoalStatusChange(goal.id, "completed");
    return;
  }

  // ── Max runs exceeded ──
  if (goal.totalRuns >= goal.maxRuns) {
    updateGoal(goal.id, { status: "abandoned", progressLog: updatedLog });
    console.log(`[Goals] Goal "${goal.name}" abandoned after reaching maxRuns (${goal.maxRuns}).`);
    notifyGoalStatusChange(goal.id, "abandoned");
    return;
  }

  // ── Track consecutive errors, auto-pause ──
  const newConsecutiveErrors = sessionStatus === "error"
    ? (goal.consecutiveErrors ?? 0) + 1
    : 0;

  if (newConsecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    updateGoal(goal.id, {
      progressLog: updatedLog,
      consecutiveErrors: newConsecutiveErrors,
      status: "paused",
    });
    console.warn(`[Goals] Goal "${goal.name}" auto-paused after ${MAX_CONSECUTIVE_ERRORS} consecutive errors.`);
    notifyGoalStatusChange(goal.id, "paused");
    return;
  }

  // Record progress + updated error count
  updateGoal(goal.id, { progressLog: updatedLog, consecutiveErrors: newConsecutiveErrors });

  // ── If goal was paused mid-run, don't schedule next ──
  const refreshed = getGoal(goal.id);
  if (!refreshed || refreshed.status !== "active") return;

  // ── Schedule next run ──
  if (refreshed.retryInterval <= 0) {
    setImmediate(() => {
      const latest = getGoal(refreshed.id);
      if (latest && latest.status === "active") triggerGoalRun(latest);
    });
  } else {
    scheduleNextRun(refreshed, refreshed.retryInterval * 60 * 1000);
  }
}

// ─── Resume active goals after app restart ────────────────────
// Call once on startup after sessionRunner is injected.
export function resumeActiveGoals(): void {
  if (!sessionRunner) {
    console.warn("[Goals] resumeActiveGoals called before sessionRunner is set");
    return;
  }

  const goals = loadGoals();
  const now = Date.now();
  let scheduled = 0;
  let immediate = 0;

  for (const goal of goals) {
    if (goal.status !== "active") continue;

    if (goal.nextRunAt) {
      const due = new Date(goal.nextRunAt).getTime();
      if (due <= now) {
        // Overdue — fire immediately
        console.log(`[Goals] Resuming overdue goal "${goal.name}" (was due ${goal.nextRunAt})`);
        setImmediate(() => {
          const latest = getGoal(goal.id);
          if (latest && latest.status === "active") triggerGoalRun(latest);
        });
        immediate++;
      } else {
        // Still in the future — reschedule remaining delay
        const remaining = due - now;
        scheduleNextRun(goal, remaining);
        scheduled++;
      }
    }
    // Goals with no nextRunAt were either:
    // - just created and triggered immediately (handled in goals:add IPC)
    // - currently running (session will complete normally)
  }

  if (immediate + scheduled > 0) {
    console.log(`[Goals] Resumed: ${immediate} immediate, ${scheduled} scheduled.`);
  }
}

// ─── Status change notifier ───────────────────────────────────
let statusChangeFn: ((goalId: string, status: string) => void) | null = null;

export function setGoalStatusChangeNotifier(fn: (goalId: string, status: string) => void): void {
  statusChangeFn = fn;
}

function notifyGoalStatusChange(goalId: string, status: string): void {
  if (statusChangeFn) statusChangeFn(goalId, status);
}

// ─── Legacy complete notifier (kept for DingTalk notification) ─
let notifyFn: ((goal: LongTermGoal) => void) | null = null;

export function setGoalCompleteNotifier(fn: (goal: LongTermGoal) => void): void {
  notifyFn = fn;
  // Bridge: send to both old notifier and new generic notifier
  setGoalStatusChangeNotifier((goalId, status) => {
    if (status === "completed") {
      const goal = getGoal(goalId);
      if (goal) fn(goal);
    }
  });
}
