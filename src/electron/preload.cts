import electron from "electron";

electron.contextBridge.exposeInMainWorld("electron", {
    subscribeStatistics: (callback) =>
        ipcOn("statistics", stats => {
            callback(stats);
        }),
    getStaticData: () => ipcInvoke("getStaticData"),
    
    // Claude Agent IPC APIs
    sendClientEvent: (event: any) => {
        electron.ipcRenderer.send("client-event", event);
    },
    onServerEvent: (callback: (event: any) => void) => {
        const cb = (_: Electron.IpcRendererEvent, payload: string) => {
            try {
                const event = JSON.parse(payload);
                callback(event);
            } catch (error) {
                console.error("Failed to parse server event:", error);
            }
        };
        electron.ipcRenderer.on("server-event", cb);
        return () => electron.ipcRenderer.off("server-event", cb);
    },
    generateSessionTitle: (userInput: string | null) => 
        ipcInvoke("generate-session-title", userInput),
    getRecentCwds: (limit?: number) => 
        ipcInvoke("get-recent-cwds", limit),
    selectDirectory: () => 
        ipcInvoke("select-directory"),
    getUserSettings: () => 
        ipcInvoke("get-user-settings"),
    saveUserSettings: (settings: any) => 
        ipcInvoke("save-user-settings", settings),
    checkEnvironment: () => 
        ipcInvoke("check-environment"),
    validateApiConfig: (baseUrl?: string, authToken?: string) => 
        ipcInvoke("validate-api-config", baseUrl, authToken),
    requestFolderAccess: (folderPath?: string) => 
        ipcInvoke("request-folder-access", folderPath),
    openPrivacySettings: () => 
        ipcInvoke("open-privacy-settings"),
    openPath: (targetPath: string) => 
        ipcInvoke("open-path", targetPath),
    installClaudeCLI: () => 
        ipcInvoke("install-claude-cli"),
    isClaudeCLIInstalled: () => 
        ipcInvoke("is-claude-cli-installed"),
    onInstallProgress: (callback: (message: string) => void) => {
        const cb = (_: Electron.IpcRendererEvent, message: string) => callback(message);
        electron.ipcRenderer.on("install-progress", cb);
        return () => electron.ipcRenderer.off("install-progress", cb);
    },
    // Image selection (path only, Agent uses built-in analyze_image tool)
    selectImage: () => 
        ipcInvoke("select-image"),
    savePastedImage: (base64Data: string, mimeType: string) => 
        ipcInvoke("save-pasted-image", base64Data, mimeType),
    // Install tools
    installNodeJs: () => 
        ipcInvoke("install-nodejs"),
    installSdk: () => 
        ipcInvoke("install-sdk"),
    // Claude config (MCP & Skills)
    getClaudeConfig: () => 
        ipcInvoke("get-claude-config"),
    saveMcpServer: (server: any) => 
        ipcInvoke("save-mcp-server", server),
    deleteMcpServer: (name: string) => 
        ipcInvoke("delete-mcp-server", name),
    readSkillContent: (skillPath: string) => 
        ipcInvoke("read-skill-content", skillPath),
    installSkill: (url: string) => 
        ipcInvoke("install-skill", url),
    getAssistantsConfig: () =>
        ipcInvoke("get-assistants-config"),
    saveAssistantsConfig: (config: AssistantsConfig) =>
        ipcInvoke("save-assistants-config", config),
    // Bot config
    getBotConfig: () =>
        ipcInvoke("get-bot-config"),
    saveBotConfig: (config: BotConfig) =>
        ipcInvoke("save-bot-config", config),
    testBotConnection: (platformConfig: BotPlatformConfig) =>
        ipcInvoke("test-bot-connection", platformConfig),
    // DingTalk bot lifecycle
    startDingtalkBot: (input: StartDingtalkBotInput) =>
        ipcInvoke("start-dingtalk-bot", input),
    stopDingtalkBot: (assistantId: string) =>
        ipcInvoke("stop-dingtalk-bot", assistantId),
    getDingtalkBotStatus: (assistantId: string) =>
        ipcInvoke("get-dingtalk-bot-status", assistantId),
    sendProactiveDingtalk: (input: SendProactiveDingtalkInput) =>
        ipcInvoke("send-proactive-dingtalk", input),
    sendProactiveMediaDingtalk: (input: SendProactiveMediaDingtalkInput) =>
        ipcInvoke("send-proactive-dingtalk-media", input),
    getDingtalkLastSeen: (assistantId: string) =>
        ipcInvoke("get-dingtalk-last-seen", assistantId),
    // Feishu bot lifecycle
    startFeishuBot: (input: StartFeishuBotInput) =>
        ipcInvoke("start-feishu-bot", input),
    stopFeishuBot: (assistantId: string) =>
        ipcInvoke("stop-feishu-bot", assistantId),
    getFeishuBotStatus: (assistantId: string) =>
        ipcInvoke("get-feishu-bot-status", assistantId),
    onFeishuBotStatus: (cb: (assistantId: string, status: FeishuBotStatus, detail?: string) => void) => {
        const handler = (_: Electron.IpcRendererEvent, payload: { assistantId: string; status: FeishuBotStatus; detail?: string }) => {
            cb(payload.assistantId, payload.status, payload.detail);
        };
        electron.ipcRenderer.on("feishu-bot-status", handler);
        return () => electron.ipcRenderer.off("feishu-bot-status", handler);
    },
    onDingtalkBotStatus: (cb: (assistantId: string, status: DingtalkBotStatus, detail?: string) => void) => {
        const handler = (_: Electron.IpcRendererEvent, payload: { assistantId: string; status: DingtalkBotStatus; detail?: string }) => {
            cb(payload.assistantId, payload.status, payload.detail);
        };
        electron.ipcRenderer.on("dingtalk-bot-status", handler);
        return () => electron.ipcRenderer.off("dingtalk-bot-status", handler);
    },
    // OpenAI Codex OAuth
    openaiLogin: () => 
        ipcInvoke("openai-login"),
    openaiLogout: () => 
        ipcInvoke("openai-logout"),
    openaiAuthStatus: () => 
        ipcInvoke("openai-auth-status"),
    // Memory
    memoryRead: (target: string, date?: string) => 
        ipcInvoke("memory-read", target, date),
    memoryWrite: (target: string, content: string, date?: string) => 
        ipcInvoke("memory-write", target, content, date),
    memoryList: () => 
        ipcInvoke("memory-list"),
    // Scheduler
    getScheduledTasks: () => 
        ipcInvoke("get-scheduled-tasks"),
    addScheduledTask: (task: any) => 
        ipcInvoke("add-scheduled-task", task),
    updateScheduledTask: (id: string, updates: any) => 
        ipcInvoke("update-scheduled-task", id, updates),
    deleteScheduledTask: (id: string) => 
        ipcInvoke("delete-scheduled-task", id),
    onSchedulerRunTask: (callback: (task: any) => void) => {
        const cb = (_: Electron.IpcRendererEvent, task: any) => callback(task);
        electron.ipcRenderer.on("scheduler:run-task", cb);
        return () => electron.ipcRenderer.off("scheduler:run-task", cb);
    },
    readDir: (dirPath: string) =>
        ipcInvoke("read-dir", dirPath),
    generateSkillTags: (persona: string, skillNames: string[], assistantName: string) =>
        ipcInvoke("generate-skill-tags", persona, skillNames, assistantName),
} satisfies Window['electron'])

function ipcInvoke<Key extends keyof EventPayloadMapping>(key: Key, ...args: any[]): Promise<EventPayloadMapping[Key]> {
    return electron.ipcRenderer.invoke(key, ...args);
}

function ipcOn<Key extends keyof EventPayloadMapping>(key: Key, callback: (payload: EventPayloadMapping[Key]) => void) {
    const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload)
    electron.ipcRenderer.on(key, cb);
    return () => electron.ipcRenderer.off(key, cb)
}
