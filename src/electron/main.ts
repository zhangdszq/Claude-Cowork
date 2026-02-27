import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from "electron"
import { ipcMainHandle, isDev, DEV_PORT } from "./util.js";
import { getPreloadPath, getUIPath, getIconPath } from "./pathResolver.js";
import { getStaticData, pollResources } from "./test.js";
import { handleClientEvent, sessions } from "./ipc-handlers.js";
// Inject the shared SessionStore into bot modules so they use the same DB connection
setSessionStore(sessions);
setFeishuSessionStore(sessions);
import type { ClientEvent } from "./types.js";
import "./libs/claude-settings.js";
import { loadUserSettings, saveUserSettings, type UserSettings } from "./libs/user-settings.js";
import { loadAssistantsConfig, saveAssistantsConfig, type AssistantsConfig } from "./libs/assistants-config.js";
import { loadBotConfig, saveBotConfig, testBotConnection, type BotPlatformConfig, type DingtalkBotConfig } from "./libs/bot-config.js";
import {
  startDingtalkBot,
  stopDingtalkBot,
  getDingtalkBotStatus,
  updateDingtalkBotConfig,
  onDingtalkBotStatusChange,
  onDingtalkSessionUpdate,
  setSessionStore,
  sendProactiveDingtalkMessage,
  sendProactiveMediaDingtalk,
  getLastSeenTargets,
  type DingtalkBotOptions,
} from "./libs/dingtalk-bot.js";
import {
  startFeishuBot,
  stopFeishuBot,
  getFeishuBotStatus,
  onFeishuBotStatusChange,
  setFeishuSessionStore,
  type FeishuBotOptions,
} from "./libs/feishu-bot.js";
import { reloadClaudeSettings } from "./libs/claude-settings.js";
import { runEnvironmentChecks, validateApiConfig } from "./libs/env-check.js";
import { openAILogin, openAILogout, getOpenAIAuthStatus, ensureCodexAuthSync } from "./libs/openai-auth.js";
import { startEmbeddedApi, stopEmbeddedApi, isEmbeddedApiRunning, setWebhookSessionRunner } from "./api/server.js";
import {
  readLongTermMemory, readDailyMemory, buildMemoryContext,
  writeLongTermMemory, appendDailyMemory, writeDailyMemory,
  listDailyMemories, getMemoryDir, getMemorySummary,
  runMemoryJanitor, refreshRootAbstract,
  readSessionState, writeSessionState, clearSessionState,
  readAbstract,
} from "./libs/memory-store.js";
import { 
  loadScheduledTasks, 
  addScheduledTask, 
  updateScheduledTask, 
  deleteScheduledTask,
  startScheduler,
  stopScheduler,
  setSchedulerSessionRunner,
  runHookTasks,
  type ScheduledTask
} from "./libs/scheduler.js";
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Memory janitor: run on startup + every 24 h ─────────────
function startMemoryJanitor(): void {
    try {
        const result = runMemoryJanitor();
        if (result.archived > 0) {
            console.log(`[MemoryJanitor] Archived ${result.archived} expired item(s).`);
        }
        refreshRootAbstract();
    } catch (e) {
        console.warn("[MemoryJanitor] Failed:", e);
    }
}

const JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

// ─── Auto-connect bots on startup ────────────────────────────
async function autoConnectBots(win: BrowserWindow): Promise<void> {
    const config = loadAssistantsConfig();
    for (const assistant of config.assistants) {
        // DingTalk
        const dingtalk = assistant.bots?.dingtalk as DingtalkBotConfig | undefined;
        if (dingtalk?.connected && dingtalk.appKey && dingtalk.appSecret) {
            console.log(`[AutoConnect] Starting DingTalk bot for assistant: ${assistant.name}`);
            try {
                await startDingtalkBot({
                    appKey: dingtalk.appKey,
                    appSecret: dingtalk.appSecret,
                    robotCode: dingtalk.robotCode,
                    corpId: dingtalk.corpId,
                    agentId: dingtalk.agentId,
                    assistantId: assistant.id,
                    assistantName: assistant.name,
                    persona: assistant.persona,
                    provider: assistant.provider,
                    model: assistant.model,
                    defaultCwd: assistant.defaultCwd,
                    messageType: dingtalk.messageType,
                    cardTemplateId: dingtalk.cardTemplateId,
                    cardTemplateKey: dingtalk.cardTemplateKey,
                    dmPolicy: dingtalk.dmPolicy,
                    groupPolicy: dingtalk.groupPolicy,
                    allowFrom: dingtalk.allowFrom,
                    maxConnectionAttempts: dingtalk.maxConnectionAttempts,
                    initialReconnectDelay: dingtalk.initialReconnectDelay,
                    maxReconnectDelay: dingtalk.maxReconnectDelay,
                    reconnectJitter: dingtalk.reconnectJitter,
                    ownerStaffIds: dingtalk.ownerStaffIds,
                });
                console.log(`[AutoConnect] DingTalk bot connected for: ${assistant.name}`);
            } catch (err) {
                console.error(`[AutoConnect] Failed to connect DingTalk bot for ${assistant.name}:`, err);
                win.webContents.send("dingtalk-bot-status", {
                    assistantId: assistant.id,
                    status: "error",
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // Feishu
        const feishu = assistant.bots?.feishu as FeishuBotConfig | undefined;
        if (feishu?.connected && feishu.appId && feishu.appSecret) {
            console.log(`[AutoConnect] Starting Feishu bot for assistant: ${assistant.name}`);
            try {
                await startFeishuBot({
                    appId: feishu.appId,
                    appSecret: feishu.appSecret,
                    domain: feishu.domain,
                    assistantId: assistant.id,
                    assistantName: assistant.name,
                    persona: assistant.persona,
                    provider: assistant.provider,
                    model: assistant.model,
                    defaultCwd: assistant.defaultCwd,
                });
                console.log(`[AutoConnect] Feishu bot connected for: ${assistant.name}`);
            } catch (err) {
                console.error(`[AutoConnect] Failed to connect Feishu bot for ${assistant.name}:`, err);
                win.webContents.send("feishu-bot-status", {
                    assistantId: assistant.id,
                    status: "error",
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
}

// Must be called before app is ready
protocol.registerSchemesAsPrivileged([
    { scheme: "localfile", privileges: { secure: true, standard: true, supportFetchAPI: true, bypassCSP: true } }
]);

app.on("ready", async () => {
    // Serve local files via localfile:// — file:// is blocked from http://localhost by Chromium
    protocol.handle("localfile", async (request) => {
        try {
            const { promises: fs } = await import("fs");
            const filePath = decodeURIComponent(new URL(request.url).pathname);
            const data = await fs.readFile(filePath);
            const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
            const mimeMap: Record<string, string> = {
                jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
                gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
                svg: "image/svg+xml", ico: "image/x-icon", tiff: "image/tiff", avif: "image/avif",
            };
            return new Response(data, { headers: { "Content-Type": mimeMap[ext] ?? "application/octet-stream" } });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    });

    // Ensure app name shows correctly in dev mode (overrides the default "Electron")
    app.setName("AI Team");

    // Set Dock icon on macOS (required in dev mode; production uses .icns from app bundle)
    if (process.platform === "darwin" && app.dock) {
        try {
            app.dock.setIcon(getIconPath());
        } catch (e) {
            console.warn("[main] Failed to set dock icon:", e);
        }
    }

    // Run memory janitor once on startup, then every 24 h
    startMemoryJanitor();
    setInterval(startMemoryJanitor, JANITOR_INTERVAL_MS);

    // Ensure Codex auth.json is in sync with stored tokens
    ensureCodexAuthSync();

    // Start the embedded API server
    console.log("Starting embedded API server...");
    const started = await startEmbeddedApi();
    if (started) {
        console.log("Embedded API server started successfully");
        // Wire webhook route to the same session handler
        setWebhookSessionRunner(handleClientEvent);
    } else {
        console.error("Failed to start embedded API server");
    }
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        webPreferences: {
            preload: getPreloadPath(),
        },
        icon: getIconPath(),
        titleBarStyle: "hiddenInset",
        backgroundColor: "#FAF9F6",
        trafficLightPosition: { x: 15, y: 18 }
    });

    if (isDev()) {
        mainWindow.loadURL(`http://localhost:${DEV_PORT}`);
    } else {
        mainWindow.loadFile(getUIPath());
    }

    pollResources(mainWindow);

    // Initialize scheduler — inject sessionRunner so tasks fire directly in main process
    startScheduler();
    setSchedulerSessionRunner(handleClientEvent);

    // Run startup hooks after window settles (5 s delay)
    setTimeout(() => {
        try { runHookTasks("startup"); } catch (e) { console.warn("[Startup] Hook error:", e); }
    }, 5000);

    // Register weekly L2→L1 memory compaction task (once, idempotent)
    try {
        const existing = loadScheduledTasks();
        const hasCompact = existing.some(t => t.id?.startsWith("memory-compact-"));
        if (!hasCompact) {
            addScheduledTask({
                name: "记忆压缩 L2→L1",
                enabled: true,
                prompt: `请执行每周记忆压缩任务：
1. 读取 ~/.vk-cowork/memory/daily/ 目录下最近 7 天的日志文件（L2）
2. 将本周的关键事件、决策、和洞察提炼，追加到 ~/.vk-cowork/memory/insights/${new Date().toISOString().slice(0, 7)}.md（L1）
3. 更新 ~/.vk-cowork/memory/insights/.abstract 索引
完成后汇报压缩了哪些内容。`,
                scheduleType: "daily",
                dailyTime: "03:00",
                dailyDays: [1], // 每周一凌晨 3 点
            });
            console.log("[Memory] Weekly L2→L1 compaction task registered.");
        }
    } catch (e) {
        console.warn("[Memory] Failed to register compaction task:", e);
    }

    // Auto-connect all bots that were previously connected
    autoConnectBots(mainWindow);

    ipcMainHandle("getStaticData", () => {
        return getStaticData();
    });

    // Handle client events
    ipcMain.on("client-event", (_, event: ClientEvent) => {
        handleClientEvent(event);
    });

    // Handle session title generation (simple fallback - can be enhanced later)
    ipcMainHandle("generate-session-title", async (_: any, userInput: string | null) => {
        if (!userInput) return "New Session";
        // Simple title generation - truncate to reasonable length
        const title = userInput.slice(0, 50).trim();
        return title || "New Session";
    });

    // Generate skill tags for an assistant using the agent SDK
    ipcMainHandle("generate-skill-tags", async (_: any, persona: string, skillNames: string[], assistantName: string) => {
        try {
            const { generateSkillTags } = await import("./api/services/runner.js");
            return await generateSkillTags(persona, skillNames, assistantName);
        } catch (error) {
            console.error("[main] Failed to generate skill tags:", error);
            return [];
        }
    });

    // Handle recent cwds request
    ipcMainHandle("get-recent-cwds", (_: any, limit?: number) => {
        const boundedLimit = limit ? Math.min(Math.max(limit, 1), 20) : 8;
        return sessions.listRecentCwds(boundedLimit);
    });

    // Handle directory selection
    ipcMainHandle("select-directory", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });
        
        if (result.canceled) {
            return null;
        }
        
        return result.filePaths[0];
    });

    // Handle user settings
    ipcMainHandle("get-user-settings", () => {
        return loadUserSettings();
    });

    ipcMainHandle("save-user-settings", (_: any, settings: Partial<UserSettings>) => {
        // Merge with existing settings to preserve fields like openaiTokens
        const existing = loadUserSettings();
        const merged = { ...existing, ...settings };
        saveUserSettings(merged);
        reloadClaudeSettings();
        return true;
    });

    ipcMainHandle("get-assistants-config", () => {
        return loadAssistantsConfig();
    });

    ipcMainHandle("save-assistants-config", (_: any, config: AssistantsConfig) => {
        const result = saveAssistantsConfig(config);
        // Sync provider/model/persona changes to already-running bots
        for (const assistant of config.assistants) {
            updateDingtalkBotConfig(assistant.id, {
                provider: assistant.provider,
                model: assistant.model,
                persona: assistant.persona,
                assistantName: assistant.name,
                defaultCwd: assistant.defaultCwd,
            });
        }
        return result;
    });

    // Bot config handlers
    ipcMainHandle("get-bot-config", () => {
        return loadBotConfig();
    });

    ipcMainHandle("save-bot-config", (_: any, config: BotConfig) => {
        return saveBotConfig(config);
    });

    ipcMainHandle("test-bot-connection", async (_: any, platformConfig: BotPlatformConfig) => {
        return await testBotConnection(platformConfig);
    });

    // DingTalk bot lifecycle handlers
    ipcMainHandle("start-dingtalk-bot", async (_: any, input: DingtalkBotOptions) => {
        try {
            await startDingtalkBot(input);
            return { status: getDingtalkBotStatus(input.assistantId) as DingtalkBotStatus };
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return { status: "error" as DingtalkBotStatus, detail };
        }
    });

    ipcMainHandle("stop-dingtalk-bot", (_: any, assistantId: string) => {
        stopDingtalkBot(assistantId);
    });

    ipcMainHandle("get-dingtalk-bot-status", (_: any, assistantId: string) => {
        return { status: getDingtalkBotStatus(assistantId) as DingtalkBotStatus };
    });

    ipcMainHandle("send-proactive-dingtalk", async (_: any, input: { assistantId: string; text: string; targets?: string[]; title?: string }) => {
        return await sendProactiveDingtalkMessage(input.assistantId, input.text, {
            targets: input.targets,
            title: input.title,
        });
    });

    ipcMainHandle("send-proactive-dingtalk-media", async (_: any, input: { assistantId: string; filePath: string; targets?: string[]; mediaType?: "image" | "voice" | "video" | "file" }) => {
        return await sendProactiveMediaDingtalk(input.assistantId, input.filePath, {
            targets: input.targets,
            mediaType: input.mediaType,
        });
    });

    ipcMainHandle("get-dingtalk-last-seen", (_: any, assistantId: string) => {
        return getLastSeenTargets(assistantId);
    });

    // Forward DingTalk bot status changes to renderer
    onDingtalkBotStatusChange((assistantId, status, detail) => {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            win.webContents.send("dingtalk-bot-status", { assistantId, status, detail });
        }
    });

    // Forward DingTalk session title/status updates to renderer via existing server-event channel
    onDingtalkSessionUpdate((sessionId, updates) => {
        const event = JSON.stringify({
            type: "session.status",
            payload: { sessionId, status: updates.status ?? "idle", title: updates.title },
        });
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            win.webContents.send("server-event", event);
        }
    });

    // Feishu bot lifecycle handlers
    ipcMainHandle("start-feishu-bot", async (_: any, input: FeishuBotOptions) => {
        try {
            await startFeishuBot(input);
            return { status: getFeishuBotStatus(input.assistantId) as FeishuBotStatus };
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return { status: "error" as FeishuBotStatus, detail };
        }
    });

    ipcMainHandle("stop-feishu-bot", (_: any, assistantId: string) => {
        stopFeishuBot(assistantId);
    });

    ipcMainHandle("get-feishu-bot-status", (_: any, assistantId: string) => {
        return { status: getFeishuBotStatus(assistantId) as FeishuBotStatus };
    });

    // Forward Feishu bot status changes to renderer
    onFeishuBotStatusChange((assistantId, status, detail) => {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            win.webContents.send("feishu-bot-status", { assistantId, status, detail });
        }
    });

    // Scheduler handlers
    ipcMainHandle("get-scheduled-tasks", () => {
        return loadScheduledTasks();
    });

    ipcMainHandle("add-scheduled-task", (_: any, task: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt">) => {
        return addScheduledTask(task);
    });

    ipcMainHandle("update-scheduled-task", (_: any, id: string, updates: Partial<ScheduledTask>) => {
        return updateScheduledTask(id, updates);
    });

    ipcMainHandle("delete-scheduled-task", (_: any, id: string) => {
        return deleteScheduledTask(id);
    });

    // Handle environment checks
    ipcMainHandle("check-environment", async () => {
        return await runEnvironmentChecks();
    });

    // Handle API config validation
    ipcMainHandle("validate-api-config", async (_: any, baseUrl?: string, authToken?: string) => {
        return await validateApiConfig(baseUrl, authToken);
    });

    // OpenAI Codex OAuth handlers
    ipcMainHandle("openai-login", async () => {
        return await openAILogin(mainWindow);
    });

    ipcMainHandle("openai-logout", () => {
        openAILogout();
        return { success: true };
    });

    ipcMainHandle("openai-auth-status", () => {
        return getOpenAIAuthStatus();
    });

    // Memory system
    ipcMainHandle("memory-read", (_: any, target: string, date?: string) => {
        if (target === "long-term") return { content: readLongTermMemory() };
        if (target === "daily") return { content: readDailyMemory(date ?? new Date().toISOString().slice(0, 10)) };
        if (target === "context") return { content: buildMemoryContext() };
        if (target === "session-state") return { content: readSessionState() };
        if (target === "abstract") return { content: readAbstract() };
        return { content: "", memoryDir: getMemoryDir() };
    });

    ipcMainHandle("memory-write", (_: any, target: string, content: string, date?: string) => {
        if (target === "long-term") { writeLongTermMemory(content); return { success: true }; }
        if (target === "daily-append") { appendDailyMemory(content, date); return { success: true }; }
        if (target === "daily") { writeDailyMemory(content, date ?? new Date().toISOString().slice(0, 10)); return { success: true }; }
        if (target === "session-state") { writeSessionState(content); return { success: true }; }
        if (target === "session-state-clear") { clearSessionState(); return { success: true }; }
        return { success: false, error: "Unknown target" };
    });

    ipcMainHandle("memory-list", () => {
        return {
            memoryDir: getMemoryDir(),
            summary: getMemorySummary(),
            dailies: listDailyMemories(),
        };
    });

    // Request folder access permission (macOS)
    // This opens a dialog for the user to select a folder, which grants access
    ipcMainHandle("request-folder-access", async (_: any, folderPath?: string) => {
        const defaultPath = folderPath || app.getPath("downloads");
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Grant Folder Access",
            message: "Please select the folder to grant access permission",
            defaultPath,
            properties: ["openDirectory", "createDirectory"],
            securityScopedBookmarks: true
        });
        
        if (result.canceled) {
            return { granted: false, path: null };
        }
        
        return { 
            granted: true, 
            path: result.filePaths[0],
            bookmark: result.bookmarks?.[0]
        };
    });

    // Open macOS Privacy & Security settings
    ipcMainHandle("open-privacy-settings", async () => {
        if (process.platform === "darwin") {
            // Open Privacy & Security > Files and Folders
            await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders");
            return true;
        }
        return false;
    });

    // Open a path in the system file manager
    ipcMainHandle("open-path", async (_: any, targetPath: string) => {
        console.log("[open-path] Opening:", targetPath);
        if (!existsSync(targetPath)) {
            mkdirSync(targetPath, { recursive: true });
        }
        const err = await shell.openPath(targetPath);
        if (err) {
            console.error("[open-path] Failed:", err);
            return false;
        }
        return true;
    });

    // Handle image selection (returns path only, Agent will use built-in analyze_image tool)
    ipcMainHandle("select-image", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Select Image",
            filters: [
                { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }
            ],
            properties: ["openFile"]
        });
        
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        
        return result.filePaths[0];
    });

    // Generate a small thumbnail data URL from a local image path
    ipcMainHandle("get-image-thumbnail", async (_: any, filePath: string) => {
        try {
            const { nativeImage } = await import("electron");
            const img = nativeImage.createFromPath(filePath);
            if (img.isEmpty()) return null;
            const size = img.getSize();
            const maxDim = 128;
            const scale = Math.min(maxDim / size.width, maxDim / size.height, 1);
            const resized = img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) });
            return resized.toDataURL();
        } catch {
            return null;
        }
    });

    // Handle file/folder selection (returns array of { path, isDir })
    ipcMainHandle("select-file", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "选择文件或文件夹",
            properties: ["openFile", "openDirectory", "multiSelections"]
        });
        
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        
        const { statSync } = await import("fs");
        return result.filePaths.map(p => {
            let isDir = false;
            try { isDir = statSync(p).isDirectory(); } catch { /* ignore */ }
            return { path: p, isDir };
        });
    });

    // Handle pasted image - save base64 to temp file and return path
    ipcMainHandle("save-pasted-image", async (_: any, base64Data: string, mimeType: string) => {
        const fs = await import("fs");
        const path = await import("path");
        const os = await import("os");
        
        try {
            // Determine file extension from mime type
            const extMap: Record<string, string> = {
                "image/png": ".png",
                "image/jpeg": ".jpg",
                "image/gif": ".gif",
                "image/webp": ".webp"
            };
            const ext = extMap[mimeType] || ".png";
            
            // Create temp file path
            const tempDir = os.tmpdir();
            const fileName = `pasted-image-${Date.now()}${ext}`;
            const filePath = path.join(tempDir, fileName);
            
            // Convert base64 to buffer and save
            const buffer = Buffer.from(base64Data, "base64");
            fs.writeFileSync(filePath, buffer);
            
            return filePath;
        } catch (error) {
            console.error("Failed to save pasted image:", error);
            return null;
        }
    });

    // Get Claude config (MCP servers and Skills)
    ipcMainHandle("get-claude-config", () => {
        const claudeDir = join(homedir(), ".claude");
        const result: ClaudeConfigInfo = {
            mcpServers: [],
            skills: []
        };

        // Read MCP servers from settings.json
        try {
            const settingsPath = join(claudeDir, "settings.json");
            if (existsSync(settingsPath)) {
                const raw = readFileSync(settingsPath, "utf8");
                const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> };
                if (parsed.mcpServers) {
                    for (const [name, config] of Object.entries(parsed.mcpServers)) {
                        result.mcpServers.push({
                            name,
                            command: config.command,
                            args: config.args,
                            env: config.env
                        });
                    }
                }
            }
        } catch (error) {
            console.error("Failed to read MCP servers:", error);
        }

        // Read Skills from ~/.claude/skills directory
        try {
            const skillsDir = join(claudeDir, "skills");
            if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
                const skillDirs = readdirSync(skillsDir);
                for (const skillName of skillDirs) {
                    // Skip hidden directories and non-directory entries
                    if (skillName.startsWith(".")) continue;
                    const skillPath = join(skillsDir, skillName);
                    if (!statSync(skillPath).isDirectory()) continue;
                    const skillFilePath = join(skillPath, "SKILL.md");
                    // Only include skills that have a SKILL.md file
                    if (!existsSync(skillFilePath)) continue;
                    let description: string | undefined;
                    try {
                        const content = readFileSync(skillFilePath, "utf8");
                        const lines = content.split("\n");
                        const descriptionLines: string[] = [];
                        let foundFirstHeading = false;
                        let collectingDescription = false;

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!foundFirstHeading && !trimmed) continue;
                            if (trimmed.startsWith("#")) {
                                if (!foundFirstHeading) {
                                    foundFirstHeading = true;
                                    collectingDescription = true;
                                    continue;
                                } else {
                                    break;
                                }
                            }
                            if (collectingDescription && trimmed) {
                                if (trimmed.startsWith("```")) continue;
                                if (trimmed.startsWith("- `") || trimmed.startsWith("* `")) continue;
                                descriptionLines.push(trimmed);
                                if (descriptionLines.length >= 3 || descriptionLines.join(" ").length > 300) break;
                            }
                        }

                        if (descriptionLines.length > 0) {
                            description = descriptionLines.join(" ").substring(0, 300);
                        }
                    } catch {
                        // Ignore read errors
                    }
                    result.skills.push({
                        name: skillName,
                        fullPath: skillFilePath,
                        description
                    });
                }
            }
        } catch (error) {
            console.error("Failed to read Skills:", error);
        }

        return result;
    });

    // Save MCP server to settings.json
    ipcMainHandle("save-mcp-server", (_: any, server: McpServer) => {
        const claudeDir = join(homedir(), ".claude");
        const settingsPath = join(claudeDir, "settings.json");
        
        try {
            // Ensure .claude directory exists
            if (!existsSync(claudeDir)) {
                mkdirSync(claudeDir, { recursive: true });
            }

            // Read existing settings or create new
            let settings: Record<string, unknown> = {};
            if (existsSync(settingsPath)) {
                const raw = readFileSync(settingsPath, "utf8");
                settings = JSON.parse(raw);
            }

            // Initialize mcpServers if not exists
            if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
                settings.mcpServers = {};
            }

            // Add or update the server
            const mcpServers = settings.mcpServers as Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
            mcpServers[server.name] = {
                command: server.command,
                ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
                ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {})
            };

            // Write back
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
            
            return { success: true, message: `MCP 服务器 "${server.name}" 已保存` };
        } catch (error) {
            console.error("Failed to save MCP server:", error);
            return { success: false, message: `保存失败: ${error instanceof Error ? error.message : String(error)}` };
        }
    });

    // Delete MCP server from settings.json
    ipcMainHandle("delete-mcp-server", (_: any, name: string) => {
        const claudeDir = join(homedir(), ".claude");
        const settingsPath = join(claudeDir, "settings.json");
        
        try {
            if (!existsSync(settingsPath)) {
                return { success: false, message: "配置文件不存在" };
            }

            const raw = readFileSync(settingsPath, "utf8");
            const settings = JSON.parse(raw) as Record<string, unknown>;

            if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
                return { success: false, message: "没有 MCP 服务器配置" };
            }

            const mcpServers = settings.mcpServers as Record<string, unknown>;
            if (!(name in mcpServers)) {
                return { success: false, message: `MCP 服务器 "${name}" 不存在` };
            }

            delete mcpServers[name];

            // Write back
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
            
            return { success: true, message: `MCP 服务器 "${name}" 已删除` };
        } catch (error) {
            console.error("Failed to delete MCP server:", error);
            return { success: false, message: `删除失败: ${error instanceof Error ? error.message : String(error)}` };
        }
    });

    // Read skill content
    ipcMainHandle("read-skill-content", (_: any, skillPath: string) => {
        try {
            if (existsSync(skillPath)) {
                return readFileSync(skillPath, "utf8");
            }
            return null;
        } catch (error) {
            console.error("Failed to read skill content:", error);
            return null;
        }
    });

    // Install skill from git URL into both ~/.claude/skills/ and ~/.codex/skills/
    ipcMainHandle("install-skill", async (_: any, url: string) => {
        const { execSync } = await import("child_process");
        const home = homedir();

        // Derive skill name from URL: last path segment without .git
        const urlClean = url.replace(/\.git\/?$/, "").replace(/\/+$/, "");
        const skillName = urlClean.split("/").pop() || "unknown-skill";

        const targets = [
            join(home, ".claude", "skills", skillName),
            join(home, ".codex", "skills", skillName),
        ];

        const results: string[] = [];

        for (const targetDir of targets) {
            try {
                if (existsSync(targetDir)) {
                    // Already exists — pull latest
                    execSync("git pull", { cwd: targetDir, timeout: 30000, stdio: "pipe" });
                    results.push(`更新: ${targetDir}`);
                } else {
                    // Ensure parent exists
                    const parentDir = join(targetDir, "..");
                    if (!existsSync(parentDir)) {
                        mkdirSync(parentDir, { recursive: true });
                    }
                    execSync(`git clone ${url} ${JSON.stringify(targetDir)}`, { timeout: 60000, stdio: "pipe" });
                    results.push(`安装: ${targetDir}`);
                }
            } catch (err) {
                results.push(`失败 (${targetDir}): ${(err as Error).message}`);
            }
        }

        console.log("[install-skill]", results);
        return { success: true, skillName, message: results.join("\n") };
    });

    // Delete (uninstall) a skill from both ~/.claude/skills/ and ~/.codex/skills/
    ipcMainHandle("delete-skill", async (_: any, skillName: string) => {
        const { rmSync } = await import("fs");
        const home = homedir();

        const targets = [
            join(home, ".claude", "skills", skillName),
            join(home, ".codex", "skills", skillName),
        ];

        const results: string[] = [];

        for (const targetDir of targets) {
            try {
                if (existsSync(targetDir)) {
                    rmSync(targetDir, { recursive: true, force: true });
                    results.push(`已删除: ${targetDir}`);
                } else {
                    results.push(`不存在: ${targetDir}`);
                }
            } catch (err) {
                results.push(`失败 (${targetDir}): ${(err as Error).message}`);
            }
        }

        console.log("[delete-skill]", results);
        return { success: true, message: results.join("\n") };
    });

    // Check if embedded API is running
    ipcMainHandle("is-sidecar-running", () => {
        return isEmbeddedApiRunning();
    });

    // Read directory contents (one level deep)
    ipcMainHandle("read-dir", (_: any, dirPath: string) => {
        const IGNORE = new Set([
            ".git", "node_modules", ".DS_Store", "__pycache__",
            ".next", "dist", "build", ".cache", ".venv", "venv",
        ]);
        try {
            const names = readdirSync(dirPath);
            const result: Array<{ name: string; path: string; isDir: boolean; size: number; modifiedAt: number }> = [];
            for (const name of names) {
                if (IGNORE.has(name) || name.startsWith(".")) continue;
                try {
                    const fullPath = join(dirPath, name);
                    const stat = statSync(fullPath);
                    result.push({
                        name,
                        path: fullPath,
                        isDir: stat.isDirectory(),
                        size: stat.size,
                        modifiedAt: stat.mtimeMs,
                    });
                } catch { /* skip inaccessible entries */ }
            }
            result.sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            return result;
        } catch (err) {
            console.error("[read-dir] Error reading", dirPath, err);
            return [];
        }
    });
});

// Stop embedded API when app is quitting
app.on("will-quit", () => {
    console.log("Stopping embedded API server...");
    stopEmbeddedApi();
});
