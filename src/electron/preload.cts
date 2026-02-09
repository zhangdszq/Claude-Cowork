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
    // OpenAI Codex OAuth
    openaiLogin: () => 
        ipcInvoke("openai-login"),
    openaiLogout: () => 
        ipcInvoke("openai-logout"),
    openaiAuthStatus: () => 
        ipcInvoke("openai-auth-status"),
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
    }
} satisfies Window['electron'])

function ipcInvoke<Key extends keyof EventPayloadMapping>(key: Key, ...args: any[]): Promise<EventPayloadMapping[Key]> {
    return electron.ipcRenderer.invoke(key, ...args);
}

function ipcOn<Key extends keyof EventPayloadMapping>(key: Key, callback: (payload: EventPayloadMapping[Key]) => void) {
    const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload)
    electron.ipcRenderer.on(key, cb);
    return () => electron.ipcRenderer.off(key, cb)
}
