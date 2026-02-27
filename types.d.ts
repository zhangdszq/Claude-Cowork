type Statistics = {
    cpuUsage: number;
    ramUsage: number;
    storageData: number;
}

type StaticData = {
    totalStorage: number;
    cpuModel: string;
    totalMemoryGB: number;
}

type OpenAITokens = {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

type OpenAIAuthStatus = {
    loggedIn: boolean;
    email?: string;
    expiresAt?: number;
}

type OpenAILoginResult = {
    success: boolean;
    email?: string;
    error?: string;
}

type UserSettings = {
    anthropicBaseUrl?: string;
    anthropicAuthToken?: string;
    proxyEnabled?: boolean;
    proxyUrl?: string;
    openaiTokens?: OpenAITokens;
    webhookToken?: string;
}

type ScheduledTaskHookFilter = {
    assistantId?: string;
    titlePattern?: string;
    onlyOnError?: boolean;
}

type ScheduledTask = {
    id: string;
    name: string;
    enabled: boolean;
    prompt: string;
    cwd?: string;
    skillPath?: string;
    scheduleType: "once" | "interval" | "daily" | "heartbeat" | "hook";
    // For "once" type
    scheduledTime?: string;
    // For "interval" type
    intervalValue?: number;
    intervalUnit?: "minutes" | "hours" | "days" | "weeks";
    // For "daily" type — run at a fixed time each day/week
    dailyTime?: string;    // "HH:MM"
    dailyDays?: number[];  // 0=Sun…6=Sat; empty = every day
    // For "heartbeat" type — periodic self-check
    heartbeatInterval?: number;  // minutes, default 30
    suppressIfShort?: boolean;   // hide session if response < 80 chars or contains <no-action>
    // For "hook" type — triggered by internal events
    hookEvent?: "startup" | "session.complete";
    hookFilter?: ScheduledTaskHookFilter;
    lastRun?: string;
    nextRun?: string;
    assistantId?: string;
    createdAt: string;
    updatedAt: string;
}

type ScheduledTaskInput = Omit<ScheduledTask, "id" | "createdAt" | "updatedAt">

type SchedulerRunTaskPayload = {
    taskId: string;
    name: string;
    prompt: string;
    cwd?: string;
    skillPath?: string;
    assistantId?: string;
}

type EnvironmentCheck = {
    id: string;
    name: string;
    status: 'ok' | 'warning' | 'error' | 'checking';
    message: string;
}

type EnvironmentCheckResult = {
    checks: EnvironmentCheck[];
    allPassed: boolean;
}

type ValidateApiResult = {
    valid: boolean;
    message: string;
}

type FolderAccessResult = {
    granted: boolean;
    path: string | null;
    bookmark?: string;
}

type InstallResult = {
    success: boolean;
    message: string;
    output?: string;
}

type McpServer = {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

type SkillInfo = {
    name: string;
    fullPath: string;
    description?: string;
}

type AssistantConfig = {
    id: string;
    name: string;
    provider: "claude" | "codex";
    model?: string;
    skillNames?: string[];
    skillTags?: string[];
    persona?: string;
    defaultCwd?: string;
    bots?: Partial<Record<BotPlatformType, BotPlatformConfig>>;
}

type AssistantsConfig = {
    assistants: AssistantConfig[];
    defaultAssistantId?: string;
}

type ClaudeConfigInfo = {
    mcpServers: McpServer[];
    skills: SkillInfo[];
}

type SaveMcpResult = {
    success: boolean;
    message: string;
}

type MemoryReadResult = {
    content: string;
    memoryDir?: string;
}

type MemoryWriteResult = {
    success: boolean;
    error?: string;
}

type MemoryFileInfo = {
    date: string;
    path: string;
    size: number;
}

type DirEntry = {
    name: string;
    path: string;
    isDir: boolean;
    size: number;
    modifiedAt: number;
}

type MemoryListResult = {
    memoryDir: string;
    summary: {
        longTermSize: number;
        dailyCount: number;
        totalSize: number;
    };
    dailies: MemoryFileInfo[];
}

type BotPlatformType = "telegram" | "feishu" | "wecom" | "discord" | "dingtalk";

type TelegramBotConfig = {
    platform: "telegram";
    token: string;
    proxy?: string;
    connected: boolean;
};

type FeishuBotConfig = {
    platform: "feishu";
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
    connected: boolean;
};

type WecomBotConfig = {
    platform: "wecom";
    corpId: string;
    agentId: string;
    secret: string;
    connected: boolean;
};

type DiscordBotConfig = {
    platform: "discord";
    token: string;
    connected: boolean;
};

type DingtalkBotConfig = {
    platform: "dingtalk";
    appKey: string;
    appSecret: string;
    /** For Card API and media download — defaults to appKey */
    robotCode?: string;
    corpId?: string;
    agentId?: string;
    /** Reply mode: "markdown" (default) or "card" (AI streaming card) */
    messageType?: "markdown" | "card";
    /** Required when messageType="card" */
    cardTemplateId?: string;
    /** Card template content field key — defaults to "msgContent" */
    cardTemplateKey?: string;
    /** Private chat policy */
    dmPolicy?: "open" | "allowlist";
    /** Group chat policy */
    groupPolicy?: "open" | "allowlist";
    /** Allowlisted staff IDs or conversation IDs */
    allowFrom?: string[];
    /** Max reconnect attempts (default: 10) */
    maxConnectionAttempts?: number;
    /** Initial reconnect delay ms (default: 1000) */
    initialReconnectDelay?: number;
    /** Max reconnect delay ms (default: 60000) */
    maxReconnectDelay?: number;
    /** Jitter factor 0–1 (default: 0.3) */
    reconnectJitter?: number;
    /**
     * Owner staff ID(s) for proactive push messages.
     * Fill in your own staffId so the bot can notify you proactively.
     */
    ownerStaffIds?: string[];
    connected: boolean;
};

type BotPlatformConfig =
    | TelegramBotConfig
    | FeishuBotConfig
    | WecomBotConfig
    | DiscordBotConfig
    | DingtalkBotConfig;

type BotConfig = {
    platforms: Partial<Record<BotPlatformType, BotPlatformConfig>>;
};

type BotTestResult = {
    success: boolean;
    message: string;
};

type DingtalkBotStatus = "disconnected" | "connecting" | "connected" | "error";

type StartDingtalkBotInput = {
    appKey: string;
    appSecret: string;
    robotCode?: string;
    corpId?: string;
    agentId?: string;
    assistantId: string;
    assistantName: string;
    persona?: string;
    provider?: "claude" | "codex";
    model?: string;
    defaultCwd?: string;
    messageType?: "markdown" | "card";
    cardTemplateId?: string;
    cardTemplateKey?: string;
    dmPolicy?: "open" | "allowlist";
    groupPolicy?: "open" | "allowlist";
    allowFrom?: string[];
    maxConnectionAttempts?: number;
    initialReconnectDelay?: number;
    maxReconnectDelay?: number;
    reconnectJitter?: number;
    ownerStaffIds?: string[];
};

type SendProactiveDingtalkInput = {
    assistantId: string;
    text: string;
    /** Target IDs: staffId, conversationId (cid...), or "user:<id>" / "group:<id>" prefix */
    targets?: string[];
    title?: string;
};

type SendProactiveMediaDingtalkInput = {
    assistantId: string;
    filePath: string;
    targets?: string[];
    mediaType?: "image" | "voice" | "video" | "file";
};

type SendProactiveDingtalkResult = {
    ok: boolean;
    error?: string;
};

type DingtalkBotStatusResult = {
    status: DingtalkBotStatus;
    detail?: string;
};

type FeishuBotStatus = "disconnected" | "connecting" | "connected" | "error";

type StartFeishuBotInput = {
    appId: string;
    appSecret: string;
    domain?: "feishu" | "lark";
    assistantId: string;
    assistantName: string;
    persona?: string;
    provider?: "claude" | "codex";
    model?: string;
    defaultCwd?: string;
    maxConnectionAttempts?: number;
};

type FeishuBotStatusResult = {
    status: FeishuBotStatus;
    detail?: string;
};

type UnsubscribeFunction = () => void;

type EventPayloadMapping = {
    statistics: Statistics;
    getStaticData: StaticData;
    "generate-session-title": string;
    "get-recent-cwds": string[];
    "select-directory": string | null;
    "get-user-settings": UserSettings;
    "save-user-settings": boolean;
    "check-environment": EnvironmentCheckResult;
    "validate-api-config": ValidateApiResult;
    "request-folder-access": FolderAccessResult;
    "open-privacy-settings": boolean;
    "open-path": boolean;
    "install-claude-cli": InstallResult;
    "is-claude-cli-installed": boolean;
    "select-image": string | null;
    "save-pasted-image": string | null;
    "select-file": { path: string; isDir: boolean }[] | null;
    "get-image-thumbnail": string | null;
    "install-nodejs": InstallResult;
    "install-sdk": InstallResult;
    "get-claude-config": ClaudeConfigInfo;
    "save-mcp-server": SaveMcpResult;
    "delete-mcp-server": SaveMcpResult;
    "read-skill-content": string | null;
    "install-skill": { success: boolean; skillName: string; message: string };
    "delete-skill": { success: boolean; message: string };
    "get-assistants-config": AssistantsConfig;
    "save-assistants-config": AssistantsConfig;
    "get-bot-config": BotConfig;
    "save-bot-config": BotConfig;
    "test-bot-connection": BotTestResult;
    "start-dingtalk-bot": DingtalkBotStatusResult;
    "stop-dingtalk-bot": void;
    "get-dingtalk-bot-status": DingtalkBotStatusResult;
    "send-proactive-dingtalk": SendProactiveDingtalkResult;
    "send-proactive-dingtalk-media": SendProactiveDingtalkResult;
    "get-dingtalk-last-seen": Array<{ target: string; isGroup: boolean; lastSeenAt: number }>;
    "start-feishu-bot": FeishuBotStatusResult;
    "stop-feishu-bot": void;
    "get-feishu-bot-status": FeishuBotStatusResult;
    "is-sidecar-running": boolean;
    // OpenAI Codex OAuth
    "openai-login": OpenAILoginResult;
    "openai-logout": { success: boolean };
    "openai-auth-status": OpenAIAuthStatus;
    // Memory
    "memory-read": MemoryReadResult;
    "memory-write": MemoryWriteResult;
    "memory-list": MemoryListResult;
    // Scheduler
    "get-scheduled-tasks": ScheduledTask[];
    "add-scheduled-task": ScheduledTask;
    "update-scheduled-task": ScheduledTask | null;
    "delete-scheduled-task": boolean;
    "read-dir": DirEntry[];
    "generate-skill-tags": string[];
}

interface Window {
    electron: {
        subscribeStatistics: (callback: (statistics: Statistics) => void) => UnsubscribeFunction;
        getStaticData: () => Promise<StaticData>;
        // Claude Agent IPC APIs
        sendClientEvent: (event: any) => void;
        onServerEvent: (callback: (event: any) => void) => UnsubscribeFunction;
        generateSessionTitle: (userInput: string | null) => Promise<string>;
        getRecentCwds: (limit?: number) => Promise<string[]>;
        selectDirectory: () => Promise<string | null>;
        getUserSettings: () => Promise<UserSettings>;
        saveUserSettings: (settings: UserSettings) => Promise<boolean>;
        checkEnvironment: () => Promise<EnvironmentCheckResult>;
        validateApiConfig: (baseUrl?: string, authToken?: string) => Promise<ValidateApiResult>;
        requestFolderAccess: (folderPath?: string) => Promise<FolderAccessResult>;
        openPrivacySettings: () => Promise<boolean>;
        openPath: (targetPath: string) => Promise<boolean>;
        installClaudeCLI: () => Promise<InstallResult>;
        isClaudeCLIInstalled: () => Promise<boolean>;
        onInstallProgress: (callback: (message: string) => void) => UnsubscribeFunction;
        // Image selection (path only, Agent uses built-in analyze_image tool)
        selectImage: () => Promise<string | null>;
        savePastedImage: (base64Data: string, mimeType: string) => Promise<string | null>;
        // File/folder selection, returns array of { path, isDir }
        selectFile: () => Promise<{ path: string; isDir: boolean }[] | null>;
        // Get file system path for a dropped File object (Electron 32+ API)
        getPathForFile: (file: File) => string;
        // Generate a thumbnail data URL for a local image
        getImageThumbnail: (filePath: string) => Promise<string | null>;
        // Install tools
        installNodeJs: () => Promise<InstallResult>;
        installSdk: () => Promise<InstallResult>;
        // Claude config (MCP & Skills)
        getClaudeConfig: () => Promise<ClaudeConfigInfo>;
        saveMcpServer: (server: McpServer) => Promise<SaveMcpResult>;
        deleteMcpServer: (name: string) => Promise<SaveMcpResult>;
        readSkillContent: (skillPath: string) => Promise<string | null>;
        installSkill: (url: string) => Promise<{ success: boolean; skillName: string; message: string }>;
        deleteSkill: (skillName: string) => Promise<{ success: boolean; message: string }>;
        getAssistantsConfig: () => Promise<AssistantsConfig>;
        saveAssistantsConfig: (config: AssistantsConfig) => Promise<AssistantsConfig>;
        // Bot config
        getBotConfig: () => Promise<BotConfig>;
        saveBotConfig: (config: BotConfig) => Promise<BotConfig>;
        testBotConnection: (platformConfig: BotPlatformConfig) => Promise<BotTestResult>;
        // DingTalk bot lifecycle
        startDingtalkBot: (input: StartDingtalkBotInput) => Promise<DingtalkBotStatusResult>;
        stopDingtalkBot: (assistantId: string) => Promise<void>;
        getDingtalkBotStatus: (assistantId: string) => Promise<DingtalkBotStatusResult>;
        onDingtalkBotStatus: (cb: (assistantId: string, status: DingtalkBotStatus, detail?: string) => void) => UnsubscribeFunction;
        sendProactiveDingtalk: (input: SendProactiveDingtalkInput) => Promise<SendProactiveDingtalkResult>;
        sendProactiveMediaDingtalk: (input: SendProactiveMediaDingtalkInput) => Promise<SendProactiveDingtalkResult>;
        getDingtalkLastSeen: (assistantId: string) => Promise<Array<{ target: string; isGroup: boolean; lastSeenAt: number }>>;
        // Feishu bot lifecycle
        startFeishuBot: (input: StartFeishuBotInput) => Promise<FeishuBotStatusResult>;
        stopFeishuBot: (assistantId: string) => Promise<void>;
        getFeishuBotStatus: (assistantId: string) => Promise<FeishuBotStatusResult>;
        onFeishuBotStatus: (cb: (assistantId: string, status: FeishuBotStatus, detail?: string) => void) => UnsubscribeFunction;
        // OpenAI Codex OAuth
        openaiLogin: () => Promise<OpenAILoginResult>;
        openaiLogout: () => Promise<{ success: boolean }>;
        openaiAuthStatus: () => Promise<OpenAIAuthStatus>;
        // Memory
        memoryRead: (target: string, date?: string) => Promise<MemoryReadResult>;
        memoryWrite: (target: string, content: string, date?: string) => Promise<MemoryWriteResult>;
        memoryList: () => Promise<MemoryListResult>;
        // Scheduler
        getScheduledTasks: () => Promise<ScheduledTask[]>;
        addScheduledTask: (task: ScheduledTaskInput) => Promise<ScheduledTask>;
        updateScheduledTask: (id: string, updates: Partial<ScheduledTask>) => Promise<ScheduledTask | null>;
        deleteScheduledTask: (id: string) => Promise<boolean>;
        onSchedulerRunTask: (callback: (task: SchedulerRunTaskPayload) => void) => UnsubscribeFunction;
        readDir: (dirPath: string) => Promise<DirEntry[]>;
        generateSkillTags: (persona: string, skillNames: string[], assistantName: string) => Promise<string[]>;
    }
}
