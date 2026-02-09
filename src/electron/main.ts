import { app, BrowserWindow, ipcMain, dialog, shell } from "electron"
import { ipcMainHandle, isDev, DEV_PORT } from "./util.js";
import { getPreloadPath, getUIPath, getIconPath } from "./pathResolver.js";
import { getStaticData, pollResources } from "./test.js";
import { handleClientEvent, sessions } from "./ipc-handlers.js";
import type { ClientEvent } from "./types.js";
import "./libs/claude-settings.js";
import { loadUserSettings, saveUserSettings, type UserSettings } from "./libs/user-settings.js";
import { reloadClaudeSettings } from "./libs/claude-settings.js";
import { runEnvironmentChecks, validateApiConfig } from "./libs/env-check.js";
import { openAILogin, openAILogout, getOpenAIAuthStatus, ensureCodexAuthSync } from "./libs/openai-auth.js";
import { startEmbeddedApi, stopEmbeddedApi, isEmbeddedApiRunning } from "./api/server.js";
import { 
  loadScheduledTasks, 
  addScheduledTask, 
  updateScheduledTask, 
  deleteScheduledTask,
  startScheduler,
  stopScheduler,
  setSchedulerWindow,
  type ScheduledTask
} from "./libs/scheduler.js";
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

app.on("ready", async () => {
    // Ensure Codex auth.json is in sync with stored tokens
    ensureCodexAuthSync();

    // Start the embedded API server
    console.log("Starting embedded API server...");
    const started = await startEmbeddedApi();
    if (started) {
        console.log("Embedded API server started successfully");
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

    // Initialize scheduler
    setSchedulerWindow(mainWindow);
    startScheduler();

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
                    const skillPath = join(skillsDir, skillName);
                    if (statSync(skillPath).isDirectory()) {
                        const skillFilePath = join(skillPath, "SKILL.md");
                        let description: string | undefined;
                        if (existsSync(skillFilePath)) {
                            try {
                                const content = readFileSync(skillFilePath, "utf8");
                                // Extract description from SKILL.md
                                // Look for content between first heading and next heading/section
                                const lines = content.split("\n");
                                const descriptionLines: string[] = [];
                                let foundFirstHeading = false;
                                let collectingDescription = false;
                                
                                for (const line of lines) {
                                    const trimmed = line.trim();
                                    
                                    // Skip empty lines at the beginning
                                    if (!foundFirstHeading && !trimmed) continue;
                                    
                                    // Found a heading
                                    if (trimmed.startsWith("#")) {
                                        if (!foundFirstHeading) {
                                            foundFirstHeading = true;
                                            collectingDescription = true;
                                            continue;
                                        } else {
                                            // Found next heading, stop collecting
                                            break;
                                        }
                                    }
                                    
                                    // Collect description lines
                                    if (collectingDescription && trimmed) {
                                        // Skip code blocks
                                        if (trimmed.startsWith("```")) continue;
                                        // Skip list items that look like commands
                                        if (trimmed.startsWith("- `") || trimmed.startsWith("* `")) continue;
                                        
                                        descriptionLines.push(trimmed);
                                        
                                        // Limit to 3 lines or 300 chars
                                        if (descriptionLines.length >= 3 || descriptionLines.join(" ").length > 300) {
                                            break;
                                        }
                                    }
                                }
                                
                                if (descriptionLines.length > 0) {
                                    description = descriptionLines.join(" ").substring(0, 300);
                                }
                            } catch {
                                // Ignore read errors
                            }
                        }
                        result.skills.push({
                            name: skillName,
                            fullPath: skillFilePath,
                            description
                        });
                    }
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

    // Check if embedded API is running
    ipcMainHandle("is-sidecar-running", () => {
        return isEmbeddedApiRunning();
    });
});

// Stop embedded API when app is quitting
app.on("will-quit", () => {
    console.log("Stopping embedded API server...");
    stopEmbeddedApi();
});
