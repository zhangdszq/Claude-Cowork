import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { app, BrowserWindow } from "electron";

// Types
export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  // Task configuration
  prompt: string;
  cwd?: string;
  skillPath?: string;
  assistantId?: string;
  // Schedule configuration
  scheduleType: "once" | "interval" | "daily";
  // For "once" type
  scheduledTime?: string;  // ISO date string
  // For "interval" type
  intervalValue?: number;
  intervalUnit?: "minutes" | "hours" | "days" | "weeks";
  // For "daily" type — fixed clock time, optional day-of-week filter
  dailyTime?: string;    // "HH:MM"
  dailyDays?: number[];  // 0=Sun…6=Sat; empty = every day
  lastRun?: string;  // ISO date string
  nextRun?: string;  // ISO date string
  // Metadata
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerState {
  tasks: ScheduledTask[];
}

// File path
const SCHEDULER_FILE = join(app.getPath("userData"), "scheduled-tasks.json");

// Ensure directory exists
function ensureDirectory() {
  const dir = dirname(SCHEDULER_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Load tasks
export function loadScheduledTasks(): ScheduledTask[] {
  try {
    if (!existsSync(SCHEDULER_FILE)) {
      return [];
    }
    const raw = readFileSync(SCHEDULER_FILE, "utf8");
    const state = JSON.parse(raw) as SchedulerState;
    return state.tasks || [];
  } catch (error) {
    console.error("Failed to load scheduled tasks:", error);
    return [];
  }
}

// Save tasks
export function saveScheduledTasks(tasks: ScheduledTask[]): void {
  ensureDirectory();
  const state: SchedulerState = { tasks };
  writeFileSync(SCHEDULER_FILE, JSON.stringify(state, null, 2), "utf8");
}

// Add task
export function addScheduledTask(task: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt">): ScheduledTask {
  const tasks = loadScheduledTasks();
  const newTask: ScheduledTask = {
    ...task,
    id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  
  // Calculate next run time
  newTask.nextRun = calculateNextRun(newTask);
  
  tasks.push(newTask);
  saveScheduledTasks(tasks);
  return newTask;
}

// Update task
export function updateScheduledTask(id: string, updates: Partial<ScheduledTask>): ScheduledTask | null {
  const tasks = loadScheduledTasks();
  const index = tasks.findIndex(t => t.id === id);
  if (index === -1) return null;
  
  tasks[index] = {
    ...tasks[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  
  // Recalculate next run time
  tasks[index].nextRun = calculateNextRun(tasks[index]);
  
  saveScheduledTasks(tasks);
  return tasks[index];
}

// Delete task
export function deleteScheduledTask(id: string): boolean {
  const tasks = loadScheduledTasks();
  const index = tasks.findIndex(t => t.id === id);
  if (index === -1) return false;
  
  tasks.splice(index, 1);
  saveScheduledTasks(tasks);
  return true;
}

// Calculate next run time
export function calculateNextRun(task: ScheduledTask): string | undefined {
  if (!task.enabled) return undefined;
  
  const now = new Date();
  
  if (task.scheduleType === "once") {
    if (!task.scheduledTime) return undefined;
    const scheduled = new Date(task.scheduledTime);
    return scheduled > now ? task.scheduledTime : undefined;
  }
  
  if (task.scheduleType === "interval") {
    if (!task.intervalValue || !task.intervalUnit) return undefined;
    
    const lastRun = task.lastRun ? new Date(task.lastRun) : now;
    const nextRun = new Date(lastRun);
    
    switch (task.intervalUnit) {
      case "minutes":
        nextRun.setMinutes(nextRun.getMinutes() + task.intervalValue);
        break;
      case "hours":
        nextRun.setHours(nextRun.getHours() + task.intervalValue);
        break;
      case "days":
        nextRun.setDate(nextRun.getDate() + task.intervalValue);
        break;
      case "weeks":
        nextRun.setDate(nextRun.getDate() + task.intervalValue * 7);
        break;
    }
    
    // If next run is in the past, calculate from now
    if (nextRun <= now) {
      const newNextRun = new Date(now);
      switch (task.intervalUnit) {
        case "minutes":
          newNextRun.setMinutes(newNextRun.getMinutes() + task.intervalValue);
          break;
        case "hours":
          newNextRun.setHours(newNextRun.getHours() + task.intervalValue);
          break;
        case "days":
          newNextRun.setDate(newNextRun.getDate() + task.intervalValue);
          break;
        case "weeks":
          newNextRun.setDate(newNextRun.getDate() + task.intervalValue * 7);
          break;
      }
      return newNextRun.toISOString();
    }
    
    return nextRun.toISOString();
  }

  if (task.scheduleType === "daily") {
    if (!task.dailyTime) return undefined;
    const [hours, minutes] = task.dailyTime.split(":").map(Number);

    // Start candidate at today's target time
    const candidate = new Date(now);
    candidate.setHours(hours, minutes, 0, 0);

    // If that moment has already passed today, advance to tomorrow
    if (candidate <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }

    // If specific weekdays are required, find the next matching day (≤7 iterations)
    if (task.dailyDays && task.dailyDays.length > 0) {
      for (let i = 0; i < 8; i++) {
        if (task.dailyDays.includes(candidate.getDay())) {
          return candidate.toISOString();
        }
        candidate.setDate(candidate.getDate() + 1);
      }
      return undefined;
    }

    return candidate.toISOString();
  }
  
  return undefined;
}

// Scheduler manager
let schedulerInterval: NodeJS.Timeout | null = null;
let mainWindow: BrowserWindow | null = null;

export function setSchedulerWindow(window: BrowserWindow) {
  mainWindow = window;
}

export function startScheduler() {
  if (schedulerInterval) return;
  
  console.log("[Scheduler] Starting scheduler...");
  
  // Check every minute
  schedulerInterval = setInterval(() => {
    checkAndRunTasks();
  }, 60 * 1000);
  
  // Also check immediately
  checkAndRunTasks();
}

export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[Scheduler] Scheduler stopped");
  }
}

function checkAndRunTasks() {
  const tasks = loadScheduledTasks();
  const now = new Date();
  
  for (const task of tasks) {
    if (!task.enabled || !task.nextRun) continue;
    
    const nextRun = new Date(task.nextRun);
    
    // If it's time to run (within 1 minute window)
    if (nextRun <= now) {
      console.log(`[Scheduler] Running task: ${task.name}`);
      runScheduledTask(task);
    }
  }
}

function runScheduledTask(task: ScheduledTask) {
  // Update last run time
  const updatedTask = updateScheduledTask(task.id, {
    lastRun: new Date().toISOString(),
  });
  
  // For "once" tasks, disable after running
  if (task.scheduleType === "once") {
    updateScheduledTask(task.id, { enabled: false });
  }
  
  // Send event to renderer to start the session
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("scheduler:run-task", {
      taskId: task.id,
      name: task.name,
      prompt: task.prompt,
      cwd: task.cwd,
      skillPath: task.skillPath,
      assistantId: task.assistantId,
    });
  }
}

// Get due tasks count (for badge display)
export function getDueTasksCount(): number {
  const tasks = loadScheduledTasks();
  const now = new Date();
  let count = 0;
  
  for (const task of tasks) {
    if (task.enabled && task.nextRun) {
      const nextRun = new Date(task.nextRun);
      // Count tasks due within next hour
      if (nextRun.getTime() - now.getTime() < 60 * 60 * 1000) {
        count++;
      }
    }
  }
  
  return count;
}
