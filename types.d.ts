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
}

type ScheduledTask = {
    id: string;
    name: string;
    enabled: boolean;
    prompt: string;
    cwd?: string;
    skillPath?: string;
    scheduleType: "once" | "interval";
    scheduledTime?: string;
    intervalValue?: number;
    intervalUnit?: "minutes" | "hours" | "days" | "weeks";
    lastRun?: string;
    nextRun?: string;
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

type ClaudeConfigInfo = {
    mcpServers: McpServer[];
    skills: SkillInfo[];
}

type SaveMcpResult = {
    success: boolean;
    message: string;
}

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
    "install-claude-cli": InstallResult;
    "is-claude-cli-installed": boolean;
    "select-image": string | null;
    "save-pasted-image": string | null;
    "install-nodejs": InstallResult;
    "install-sdk": InstallResult;
    "get-claude-config": ClaudeConfigInfo;
    "save-mcp-server": SaveMcpResult;
    "delete-mcp-server": SaveMcpResult;
    "read-skill-content": string | null;
    "is-sidecar-running": boolean;
    // OpenAI Codex OAuth
    "openai-login": OpenAILoginResult;
    "openai-logout": { success: boolean };
    "openai-auth-status": OpenAIAuthStatus;
    // Scheduler
    "get-scheduled-tasks": ScheduledTask[];
    "add-scheduled-task": ScheduledTask;
    "update-scheduled-task": ScheduledTask | null;
    "delete-scheduled-task": boolean;
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
        installClaudeCLI: () => Promise<InstallResult>;
        isClaudeCLIInstalled: () => Promise<boolean>;
        onInstallProgress: (callback: (message: string) => void) => UnsubscribeFunction;
        // Image selection (path only, Agent uses built-in analyze_image tool)
        selectImage: () => Promise<string | null>;
        savePastedImage: (base64Data: string, mimeType: string) => Promise<string | null>;
        // Install tools
        installNodeJs: () => Promise<InstallResult>;
        installSdk: () => Promise<InstallResult>;
        // Claude config (MCP & Skills)
        getClaudeConfig: () => Promise<ClaudeConfigInfo>;
        saveMcpServer: (server: McpServer) => Promise<SaveMcpResult>;
        deleteMcpServer: (name: string) => Promise<SaveMcpResult>;
        readSkillContent: (skillPath: string) => Promise<string | null>;
        // OpenAI Codex OAuth
        openaiLogin: () => Promise<OpenAILoginResult>;
        openaiLogout: () => Promise<{ success: boolean }>;
        openaiAuthStatus: () => Promise<OpenAIAuthStatus>;
        // Scheduler
        getScheduledTasks: () => Promise<ScheduledTask[]>;
        addScheduledTask: (task: ScheduledTaskInput) => Promise<ScheduledTask>;
        updateScheduledTask: (id: string, updates: Partial<ScheduledTask>) => Promise<ScheduledTask | null>;
        deleteScheduledTask: (id: string) => Promise<boolean>;
        onSchedulerRunTask: (callback: (task: SchedulerRunTaskPayload) => void) => UnsubscribeFunction;
    }
}
